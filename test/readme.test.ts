import { describe, expect, test } from "bun:test";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

/** The first fenced `sh` block following a heading, as a list of lines. */
function shellBlockUnder(markdown: string, heading: string): string[] {
  const afterHeading = markdown.split(`## ${heading}`)[1];
  if (afterHeading === undefined) throw new Error(`no "## ${heading}" heading`);
  const fenced = afterHeading.split("```sh\n")[1]?.split("\n```")[0];
  if (fenced === undefined) throw new Error(`no sh block under "## ${heading}"`);
  return fenced.split("\n");
}

describe("README quickstart", () => {
  test("matches the Fresh-worktree quickstart in .orca/project.md line for line", async () => {
    const readme = await Bun.file(`${REPO_ROOT}README.md`).text();
    const project = await Bun.file(`${REPO_ROOT}.orca/project.md`).text();

    const fromReadme = shellBlockUnder(readme, "Fresh-worktree quickstart");
    const fromProject = shellBlockUnder(project, "Fresh-worktree quickstart");

    expect(fromProject.length).toBeGreaterThan(0);
    expect(fromReadme).toEqual(fromProject);
  });

  test("the quickstart runs the commands package.json actually declares", async () => {
    const readme = await Bun.file(`${REPO_ROOT}README.md`).text();
    const pkg = await Bun.file(`${REPO_ROOT}package.json`).json();

    const invoked = new Set(
      shellBlockUnder(readme, "Fresh-worktree quickstart")
        .map((line) => /^bun run ([a-z-]+)/.exec(line)?.[1])
        .filter((name): name is string => name !== undefined),
    );

    expect(invoked.size).toBeGreaterThan(0);
    for (const name of invoked) expect(pkg.scripts).toHaveProperty(name);
  });
});
