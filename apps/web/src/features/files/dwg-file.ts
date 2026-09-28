export function isDwgFile(name: string, mime = "") {
  return /\.dwg$/i.test(name) || /(?:application|image)\/(?:vnd\.|x-)?dwg\b|application\/acad/i.test(mime);
}
