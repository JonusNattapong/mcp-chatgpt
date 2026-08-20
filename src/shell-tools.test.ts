import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyFilePatch, runShellCommand } from './shell-tools.js';

test('shell_command runs in the requested directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcp-shell-'));
  try {
    const result = await runShellCommand({
      command: 'node -e "process.stdout.write(process.cwd())"',
      root,
      timeoutMs: 10_000,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(path.resolve(result.stdout), path.resolve(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('shell_command rejects a working directory outside the root', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcp-shell-'));
  try {
    await assert.rejects(
      runShellCommand({ command: 'node --version', root, workdir: '..' }),
      /outside the configured shell root/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('apply_patch adds, updates, moves, and deletes files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcp-patch-'));
  try {
    await applyFilePatch(root, [
      '*** Begin Patch',
      '*** Add File: src/example.txt',
      '+hello',
      '*** End Patch',
    ].join('\n'));
    assert.equal(await readFile(path.join(root, 'src/example.txt'), 'utf8'), 'hello\n');

    await applyFilePatch(root, [
      '*** Begin Patch',
      '*** Update File: src/example.txt',
      '@@',
      '-hello',
      '+hello world',
      '*** Move to: ignored-position.txt',
      '*** End Patch',
    ].join('\n')).then(
      () => assert.fail('Move header after hunks must not be accepted'),
      () => undefined,
    );

    await applyFilePatch(root, [
      '*** Begin Patch',
      '*** Update File: src/example.txt',
      '*** Move to: src/renamed.txt',
      '@@',
      '-hello',
      '+hello world',
      '*** End Patch',
    ].join('\n'));
    assert.equal(await readFile(path.join(root, 'src/renamed.txt'), 'utf8'), 'hello world\n');

    await applyFilePatch(root, [
      '*** Begin Patch',
      '*** Delete File: src/renamed.txt',
      '*** End Patch',
    ].join('\n'));
    await assert.rejects(readFile(path.join(root, 'src/renamed.txt')), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('apply_patch rejects paths outside the root', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcp-patch-'));
  try {
    await assert.rejects(applyFilePatch(root, [
      '*** Begin Patch',
      '*** Add File: ../escape.txt',
      '+nope',
      '*** End Patch',
    ].join('\n')), /outside the configured shell root/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
