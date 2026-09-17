import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url);
const { isExtensionPackage } = await jiti.import('./bundled-extensions.ts');

test('bundled plugin recognition includes installer-pinned npm sources without matching other names', () => {
  for (const source of ['pi-mcp-adapter', 'npm:pi-mcp-adapter', 'npm:pi-mcp-adapter@2.22.0', 'C:\\agent\\pi-web-extensions\\pi-mcp-adapter']) {
    assert.equal(isExtensionPackage(source, 'pi-mcp-adapter'), true, source);
  }
  assert.equal(isExtensionPackage('npm:pi-mcp-adapter-extra@2.22.0', 'pi-mcp-adapter'), false);
});
