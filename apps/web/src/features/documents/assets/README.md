# PDF CJK font

`NotoSansSC-Regular.woff2` is the browser delivery form of the original
`NotoSansSC-Regular.ttf`. Both retain all 28,412 glyphs and 28,363 Unicode
codepoints, including identical outlines and horizontal/vertical metrics. The
WOFF2 file is not a subset. The original TTF remains the reference fixture for
PDF rendering tests. Vite ships only the WOFF2 referenced by the browser loader.

The font license and attribution remain in `NotoSansSC-OFL.txt` and
`NotoSansSC-LICENSE.txt`.

Regenerate with Python fontTools and Brotli installed:

```python
from fontTools.ttLib import TTFont

font = TTFont("NotoSansSC-Regular.ttf")
font.flavor = "woff2"
font.save("NotoSansSC-Regular.woff2")
```

After regeneration, compare the complete cmap, glyph order, glyph outlines and
`hmtx`/`vmtx` metrics against the TTF, then run the isolated PDF browser regression.
