import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';
import test from 'node:test';
import { buildPresentation } from '../../presentation-build';

test('published presentation uses same-origin scripts and fonts under production CSP', async () => {
  const source = await readFile(
    new URL('../../../../presentation/palka-presentation.html', import.meta.url),
    'utf8',
  );
  const assets = buildPresentation(source);
  const html = assets.find((asset) => asset.fileName.endsWith('.html'))?.source;
  assert.equal(typeof html, 'string');
  assert.doesNotMatch(html as string, /<script>|data:font/);
  const scripts = [...(html as string).matchAll(/<script src="\.\/([^"]+)" defer><\/script>/g)];
  assert.equal(scripts.length, 1);
  for (const [, name] of scripts) {
    const script = assets.find((asset) => asset.fileName === `presentation/${name}`);
    assert.ok(script);
    assert.equal(script.source, source.match(/<script>([\s\S]*?)<\/script>/)?.[1]);
    assert.doesNotThrow(() => new Script(script.source as string));
  }
  const fonts = [...source.matchAll(/data:font\/woff2;base64,([A-Za-z0-9+/=]+)/g)];
  assert.equal(fonts.length, 3);
  fonts.forEach(([, data], index) => {
    const name = `palka-font-${index + 1}.woff2`;
    assert.ok((html as string).includes(`./${name}`));
    assert.deepEqual(
      assets.find((asset) => asset.fileName === `presentation/${name}`)?.source,
      Buffer.from(data, 'base64'),
    );
  });
  assert.equal((html as string).match(/<section\b/g)?.length, 5);
  assert.ok((html as string).includes('data:image/gif;base64,'));
});
