import { createTheme } from '@mui/material/styles';

const base = {
  colors: { page: '#f6f2ef', surface: '#fffdfb', surfaceMuted: '#fff0e9', text: '#272321', textMuted: '#766e69', primary: '#d55b3a', onPrimary: '#fff', positive: '#327455', warning: '#a66b19', negative: '#a94343', evidence: '#426e9a', border: '#e8ded8' },
  typography: { displayFamily: 'Inter, "PingFang SC", sans-serif', bodyFamily: 'Inter, "PingFang SC", sans-serif', displayWeight: 780, bodyWeight: 400, scale: { xs: 12, sm: 14, md: 16, lg: 20, xl: 28 } },
  shape: { cardRadius: 16, sheetRadius: 28, buttonRadius: 14, chipRadius: 999 },
  spacing: { section: 24, card: 16, inline: 8 }, elevation: { card: '0 12px 34px #482d2112', sheet: '0 -24px 70px #1d14112b', floating: '0 8px 24px #482d2120' },
  motion: { fast: 160, normal: 260, easing: 'cubic-bezier(.22,.9,.25,1)' }, assets: {},
};

const definitions = {
  warm: { label: '暖橙编辑风' },
  y2k: { label: '千禧数码风', colors: { page: '#e9e5ff', surface: '#fffaff', surfaceMuted: '#ffe3f7', text: '#21152d', textMuted: '#675b75', primary: '#cf178f', onPrimary: '#fff', positive: '#16736d', warning: '#8a5b00', negative: '#a42356', evidence: '#345e9a', border: '#c7bbeb' }, shape: { cardRadius: 22, sheetRadius: 28 }, elevation: { card: '5px 5px 0 #21152d' } },
  western: { label: '牛仔风', colors: { page: '#ece8df', surface: '#fffaf0', surfaceMuted: '#e3d4bc', text: '#182f42', textMuted: '#536271', primary: '#24516e', onPrimary: '#fff', positive: '#2f654d', warning: '#896022', negative: '#a13d32', evidence: '#3d6883', border: '#a99377' }, typography: { displayFamily: 'Georgia, "Noto Serif SC", serif' }, shape: { cardRadius: 7, sheetRadius: 18 }, elevation: { card: '4px 4px 0 #a99377' }, assets: { pageTexture: '/assets/themes/western/denim-texture.svg', divider: '/assets/themes/western/stitch.svg' } },
  journal: { label: '手账风', colors: { page: '#eeeae0', surface: '#fffdf6', surfaceMuted: '#f4e5d8', text: '#292b2b', textMuted: '#616363', primary: '#526c66', onPrimary: '#fff', positive: '#456c56', warning: '#8d6a24', negative: '#a14e4e', evidence: '#4e7191', border: '#d4c8b3' }, typography: { displayFamily: '"Segoe Print", "KaiTi", cursive' }, shape: { cardRadius: 3, sheetRadius: 12 }, elevation: { card: '3px 5px 0 #d4c8b3' }, assets: { pageTexture: '/assets/themes/journal/paper-texture.svg', divider: '/assets/themes/journal/stamp.svg' } },
};

export function getThemeTokens(name) {
  const item = definitions[name] || definitions.warm;
  return Object.fromEntries(Object.entries(base).map(([key, value]) => [key, typeof value === 'object' ? { ...value, ...(item[key] || {}) } : item[key] || value]));
}

export const themeNames = Object.keys(definitions);
export const themeLabels = Object.fromEntries(Object.entries(definitions).map(([key, value]) => [key, value.label]));
export function createShiguangTheme(name) {
  const tokens = getThemeTokens(name);
  return createTheme({ palette: { mode: 'light', primary: { main: tokens.colors.primary, contrastText: tokens.colors.onPrimary }, background: { default: tokens.colors.page, paper: tokens.colors.surface }, text: { primary: tokens.colors.text, secondary: tokens.colors.textMuted } }, shape: { borderRadius: tokens.shape.cardRadius }, typography: { fontFamily: tokens.typography.bodyFamily, h3: { fontFamily: tokens.typography.displayFamily, fontWeight: tokens.typography.displayWeight }, h4: { fontFamily: tokens.typography.displayFamily, fontWeight: tokens.typography.displayWeight }, button: { textTransform: 'none', fontWeight: 750 } } });
}

export function themeStyle(name) {
  const t = getThemeTokens(name);
  return { '--accent': t.colors.primary, '--accent-soft': t.colors.surfaceMuted, '--page': t.colors.page, '--surface': t.colors.surface, '--line': t.colors.border, '--ink': t.colors.text, '--muted': t.colors.textMuted, '--positive': t.colors.positive, '--negative': t.colors.negative, '--evidence': t.colors.evidence, '--shadow': t.elevation.card, '--section-gap': `${t.spacing.section}px`, '--card-radius': `${t.shape.cardRadius}px`, '--display-family': t.typography.displayFamily, '--page-texture': t.assets.pageTexture ? `url(${t.assets.pageTexture})` : 'none' };
}
