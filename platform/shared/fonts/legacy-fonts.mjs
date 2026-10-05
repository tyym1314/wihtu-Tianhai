/** Applied only to the staged platform copy; upstream prototype CSS stays intact. */
export function localizeLegacyFonts(source, game) {
  const imports = [...source.matchAll(/@import\s+url\(['"]https:\/\/fonts\.googleapis\.com\/[^'"]+['"]\);/g)];
  if (imports.length !== 1) throw new Error(`Expected one upstream font import for ${game}`);
  let local;
  if (game === 'thunder') {
    if (!imports[0][0].includes('Cinzel') || !imports[0][0].includes('Noto+Sans+Arabic')) throw new Error('Thunder font families changed');
    local = "@import '../fonts/cinzel.css';\n@import '../fonts/noto-sans-arabic.css';";
  } else if (game === 'tiger') {
    if (!imports[0][0].includes('Cormorant+Garamond') || !imports[0][0].includes('Noto+Sans+SC')) throw new Error('Tiger font families changed');
    local = "@import '../../fonts/cormorant-garamond.css';\n@import '../../fonts/noto-sans-arabic.css';";
    const original = "'Noto Sans SC',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
    if (!source.includes(original)) throw new Error('Tiger system font boundary changed');
    // Let each OS provide its complete Chinese font coverage, including user names.
    // A screenshot-derived downloadable subset would silently lose dynamic glyphs.
    source = source.replace(original, "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei','Noto Sans CJK SC','Noto Sans Arabic',sans-serif");
    source = source.replace("'Noto Sans SC','STKaiti',serif", "system-ui,'PingFang SC','Microsoft YaHei','Noto Sans CJK SC','STKaiti',serif");
    if (source.includes("'Noto Sans SC'")) throw new Error('Unmapped Tiger Chinese font use');
  } else throw new Error(`Unknown legacy font consumer: ${game}`);
  source = source.replace(imports[0][0], local);
  if (/@import\s+(?:url\()?['"]?(?:https?:)?\/\//.test(source)) throw new Error(`External CSS import remains in ${game}`);
  return source;
}
