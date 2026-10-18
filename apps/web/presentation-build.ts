export interface PresentationAsset {
  fileName: string;
  source: string | Uint8Array;
}

// Keep the authoring HTML portable, but serve executable code and fonts from
// the same origin in production to satisfy the public site's strict CSP.
export function buildPresentation(source: string): PresentationAsset[] {
  const assets: PresentationAsset[] = [];
  let scriptIndex = 0;
  let fontIndex = 0;
  const html = source
    .replace(/<script>([\s\S]*?)<\/script>/g, (_match, script: string) => {
      const name = `palka-controls-${++scriptIndex}.js`;
      assets.push({ fileName: `presentation/${name}`, source: script });
      return `<script src="./${name}" defer></script>`;
    })
    .replace(/data:font\/woff2;base64,([A-Za-z0-9+/=]+)/g, (_match, font: string) => {
      const name = `palka-font-${++fontIndex}.woff2`;
      assets.push({
        fileName: `presentation/${name}`,
        source: Buffer.from(font, 'base64'),
      });
      return `./${name}`;
    });
  if (scriptIndex !== 1 || fontIndex !== 3) {
    throw new Error('Expected one presentation script and three embedded fonts');
  }
  assets.push({ fileName: 'presentation/palka-presentation.html', source: html });
  return assets;
}
