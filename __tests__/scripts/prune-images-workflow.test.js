import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// prune-images.yml is the trigger for the clean-up when a PR closes. Since 8 Dec 2025 GitHub runs a
// pull_request_target workflow from the default branch (`main`) and, from 2 Dec 2026, blocks it on public
// repositories by default, so the PR-close clean-up has to use pull_request (see the comment in the workflow).
const workflow = readFileSync(join(process.cwd(), '.github/workflows/prune-images.yml'), 'utf8');
const withoutComments = workflow.replace(/^\s*#.*$/gm, '');

describe('prune-images workflow trigger', () => {
  it('clears on pull_request closed', () => {
    expect(workflow).toMatch(/^ {2}pull_request:\n {4}types: \[closed\]/m);
  });

  it('never uses pull_request_target outside a comment', () => {
    expect(withoutComments).not.toMatch(/pull_request_target/);
  });

  it('keeps the fork and Dependabot guards on the pull_request event', () => {
    expect(workflow).toMatch(/github\.event_name != 'pull_request' \|\|/);
    expect(workflow).toMatch(/github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
    expect(workflow).toMatch(/github\.actor != 'dependabot\[bot\]'/);
  });

  it('takes the script from the base branch and never checks out the PR head', () => {
    expect(workflow).toMatch(/ref: \$\{\{ github\.event\.pull_request\.base\.ref \|\| github\.ref \}\}/);
    expect(workflow).not.toMatch(/ref: \$\{\{[^}]*head\.(ref|sha)/);
    expect(workflow).toMatch(/--closed-pr "\$CLOSED_PR"/);
  });
});
