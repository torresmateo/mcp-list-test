/**
 * One MCP session against a gateway, and the only place that knows how the
 * SDK negotiates a protocol revision.
 *
 * It is deliberately the only such place. DESIGN.md decision 15 defers the
 * `modern` era (`2026-07-28`) — a different handshake, not a different version
 * string — and the operator wants room to reach it later, possibly with a
 * hand-rolled client. Keeping "open a session, tell me what was negotiated"
 * behind one function means that swap is a file, not a refactor. The logging
 * `fetch` (decision 4) is injected from outside for the same reason: it sits
 * at the transport boundary and survives a change of client underneath it.
 *
 * Two failure modes get their own error types, because they are the ones that
 * would otherwise look like a normal run:
 *
 *  - {@link UnsupportedRevisionError} — asked for a revision this client
 *    cannot request. `Client.connect()` offers the first legacy entry of
 *    `supportedProtocolVersions`, so a probe told `--protocol 2026-07-28`
 *    would otherwise measure something else and label the file with what was
 *    asked for. That is the "wrong protocol version tested" failure.
 *  - {@link RevisionMismatchError} — the gateway answered a different revision.
 *    The v2 client *rejects* a negotiated version outside its supported list
 *    by throwing, so this is caught rather than returned.
 */
import {
  Client,
  SUPPORTED_PROTOCOL_VERSIONS,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { ARCADE_USER_ID_HEADER } from "./headers.ts";

/** Protocol revisions this client can actually request, in its own order. */
export const REQUESTABLE_REVISIONS: readonly string[] = SUPPORTED_PROTOCOL_VERSIONS;

/** Asked for a revision the client cannot put in an `initialize`. */
export class UnsupportedRevisionError extends Error {
  readonly revision: string;
  readonly supported: readonly string[];

  constructor(revision: string) {
    super(
      `unsupported protocol revision ${revision}; this client can request ${REQUESTABLE_REVISIONS.join(", ")}`,
    );
    this.name = "UnsupportedRevisionError";
    this.revision = revision;
    this.supported = REQUESTABLE_REVISIONS;
  }
}

/** The gateway negotiated a revision other than the one requested. */
export class RevisionMismatchError extends Error {
  readonly requested: string;
  readonly negotiated: string;

  constructor(requested: string, negotiated: string, options?: { cause?: unknown }) {
    super(`requested protocol revision ${requested}, gateway negotiated ${negotiated}`, options);
    this.name = "RevisionMismatchError";
    this.requested = requested;
    this.negotiated = negotiated;
  }
}

/**
 * The v2 client's wording when it refuses a negotiated version it does not
 * implement. Matched so the negotiated revision can be recovered from the
 * rejection; the wire-observed value from the request log is preferred when
 * there is one, so a change in this wording degrades a `version-mismatch` to a
 * plain `error` rather than to a silently clean run.
 */
const REJECTED_VERSION = /protocol version is not supported:\s*([^\s"',}]+)/i;

/** The negotiated revision named in a connect rejection, if it named one. */
export function negotiatedRevisionFromRejection(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  return REJECTED_VERSION.exec(message)?.[1];
}

/** Throws unless `revision` is one this client can put in an `initialize`. */
export function assertRequestableRevision(revision: string): void {
  if (!REQUESTABLE_REVISIONS.includes(revision)) throw new UnsupportedRevisionError(revision);
}

export interface OpenSessionOptions {
  /** Streamable HTTP endpoint of the gateway. */
  url: string;
  /** Revision to request. Validated before anything is sent. */
  revision: string;
  /** The generated id sent in the Arcade user header on every request. */
  userId: string;
  /** Bearer for the gateway. Sent on every request, never logged. */
  apiKey: string;
  /** The logging fetch from `createRequestLog`. */
  fetchImpl: (url: string | URL, init?: RequestInit) => Promise<Response>;
  /**
   * The revision observed in the `initialize` result on the wire. Preferred
   * over parsing the client's rejection when the two are both available.
   */
  observedRevision?: () => string | undefined;
  /**
   * How long one JSON-RPC request may wait for its reply before the client
   * gives up on it.
   *
   * It exists because of what a gateway that *accepts* a request and never
   * answers it does to this probe: the response stream ends, the wrapper
   * settles its own bookkeeping, and the SDK goes on waiting for a reply that
   * can never arrive — for `DEFAULT_REQUEST_TIMEOUT_MSEC`, 60 s, per request.
   * The run still completes and still writes its file, but an operator watching
   * a repetition sit for a minute cannot tell that from a hang, and five
   * repetitions is five minutes of it.
   *
   * Omitted leaves the SDK's own default in place, which is what a live run
   * gets unless the operator says otherwise — deliberately, and the reasoning
   * is in `src/probe.ts` beside the constant: a deadline shorter than the
   * effect being measured turns a high hook fan-out into a timeout error
   * instead of a finding.
   */
  requestTimeoutMs?: number;
}

export interface ProbeSession {
  client: Client;
  /** `{ timeout }` when the caller set one, `{}` otherwise. */
  requestOptions: { timeout?: number };
  /** The revision the gateway actually negotiated. Equals the request, or this throws. */
  negotiatedRevision: string;
  /** `legacy` or `modern` — DESIGN.md decision 15. `null` if the client did not say. */
  era: string | null;
  close(): Promise<void>;
}

/**
 * Opens one fresh session, or throws.
 *
 * `supportedProtocolVersions: [revision]` is what makes `--protocol` a real
 * argument: the legacy handshake offers the first legacy entry of that list,
 * so the probe requests exactly the revision it was told to and accepts
 * nothing else.
 */
export async function openSession(options: OpenSessionOptions): Promise<ProbeSession> {
  assertRequestableRevision(options.revision);

  const transport = new StreamableHTTPClientTransport(new URL(options.url), {
    requestInit: {
      headers: {
        [ARCADE_USER_ID_HEADER]: options.userId,
        authorization: `Bearer ${options.apiKey}`,
      },
    },
    fetch: options.fetchImpl,
  });
  const client = new Client(
    { name: "mcp-list-test-probe", version: "0.1.0" },
    { supportedProtocolVersions: [options.revision] },
  );

  const timeout =
    options.requestTimeoutMs === undefined ? {} : { timeout: options.requestTimeoutMs };

  try {
    await client.connect(transport, timeout);
  } catch (error) {
    await transport.close().catch(() => {});
    const negotiated = options.observedRevision?.() ?? negotiatedRevisionFromRejection(error);
    if (negotiated !== undefined && negotiated !== options.revision) {
      throw new RevisionMismatchError(options.revision, negotiated, { cause: error });
    }
    throw error;
  }

  // Belt and braces: a client that returned cleanly on a downgrade would be
  // the silent failure this whole slice guards against, so the negotiated
  // revision is checked rather than assumed even on the success path.
  const negotiated =
    client.getNegotiatedProtocolVersion() ?? options.observedRevision?.() ?? options.revision;
  if (negotiated !== options.revision) {
    await client.close().catch(() => {});
    throw new RevisionMismatchError(options.revision, negotiated);
  }

  return {
    client,
    negotiatedRevision: negotiated,
    /** The same bound, for the calls this session makes after `connect`. */
    requestOptions: timeout,
    era: client.getProtocolEra() ?? null,
    async close() {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    },
  };
}
