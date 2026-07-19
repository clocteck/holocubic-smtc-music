# SMTC Music Font Build

`smtc_music` can display lyrics and metadata in English, Chinese, Japanese, and Korean by loading:

```text
/sd/apps/smtc_music/font/smtc_cjk_16.bin
```

The app falls back to `xiaozhi_common3500_16.bin` if the compiled font is absent.

## Build

Install or locate `lv_font_conv`, then run from the repository root:

```powershell
.\smtc_music\font\build_smtc_cjk_font.ps1 `
  -ConverterPath C:\path\to\lv_font_conv.js
```

Optional font overrides:

```powershell
.\smtc_music\font\build_smtc_cjk_font.ps1 `
  -ConverterPath C:\path\to\lv_font_conv.js `
  -ChineseFont C:\Windows\Fonts\NotoSansSC-VF.ttf `
  -JapaneseFont C:\Windows\Fonts\NotoSansSC-VF.ttf `
  -KoreanFont C:\Windows\Fonts\malgun.ttf
```

The generated file is written to:

```text
smtc_music/package/font/smtc_cjk_16.bin
```

The default build uses `--bpp 1` for crisper text on the HoloCubic dot-matrix display. Use `-Bpp 2` only if smoother grayscale text is preferred.

Then redeploy:

```powershell
cubic --host http://192.168.3.168/devtools push --force smtc_music\package /sd/apps/smtc_music
```

## Coverage

- English: ASCII `0x20-0x7F`
- Chinese: existing project Simplified/Traditional common Han charsets
- Japanese: kana range plus existing JIS/common Han charset
- Korean: Hangul syllables range `0xAC00-0xD7A3`
- Metadata/lyrics punctuation: project CJK punctuation and common music symbols

This is intentionally a practical lyric/UI font, not a full Unicode font.
