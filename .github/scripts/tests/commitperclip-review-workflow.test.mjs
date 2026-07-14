import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workflowPath = resolve(__dirname, '../../workflows/commitperclip-review.yml');

test('commitperclip review workflow can upsert PR issue comments', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  assert.match(
    workflow,
    /PR comments are issue comments in GitHub's API; the quality gate upserts one\.[\s\S]*issues: write/,
  );
});
