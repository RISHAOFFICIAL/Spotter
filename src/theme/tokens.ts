/* eslint-disable */
// AUTO-GENERATED from design/tokens.json — do not edit by hand.
// Run `npm run tokens` to regenerate; `npm run tokens:check` verifies sync.
// Source of truth: /home/team/shared/design/tokens.json

export const meta = {
  appName: 'SPOTTER',
  theme: 'dark (default)',
  platforms: 'React Native + Expo, iOS + Android',
  updated: '2026-09-02',
};

export const colors = {
  background: {
    base: {
      hex: '#0a0c08',
      rgba: 'rgba(10, 12, 8, 1)',
      use: 'app background, deepest layer',
    },
    surface: {
      hex: '#131610',
      rgba: 'rgba(19, 22, 16, 1)',
      use: 'cards, feed items, bottom bar',
    },
    raised: {
      hex: '#1b1f15',
      rgba: 'rgba(27, 31, 21, 1)',
      use: 'headers, sheet body, button wells',
    },
    overlay: {
      hex: '#23281b',
      rgba: 'rgba(35, 40, 27, 1)',
      use: 'pressed states, input fill',
    },
    scrim: {
      hex: '#0a0c08',
      rgba: 'rgba(10, 12, 8, 0.72)',
      use: 'modal/sheet backdrop',
    },
    hairline: {
      hex: '#ffffff',
      rgba: 'rgba(255, 255, 255, 0.08)',
      use: '1px borders/dividers on dark',
    },
  },
  brand: {
    primary: {
      hex: '#c6f135',
      rgba: 'rgba(198, 241, 53, 1)',
      use: 'primary action color (volt)',
    },
    onPrimary: {
      hex: '#121408',
      rgba: 'rgba(18, 20, 8, 1)',
      use: 'text/icon on volt fills',
    },
    primaryDim: {
      hex: '#9cc22b',
      rgba: 'rgba(156, 194, 43, 0.35)',
      use: 'primary at 35% for pressed tint / soft accents',
    },
    primaryGlow: {
      hex: '#c6f135',
      rgba: 'rgba(198, 241, 53, 0.35)',
      use: 'camera button glow shadow',
    },
  },
  text: {
    primary: {
      hex: '#f4f6ee',
      rgba: 'rgba(244, 246, 238, 1)',
      use: 'headings, primary content',
    },
    secondary: {
      hex: '#a9b09b',
      rgba: 'rgba(169, 176, 155, 1)',
      use: 'body, sublabels',
    },
    muted: {
      hex: '#6c7360',
      rgba: 'rgba(108, 115, 96, 1)',
      use: 'timestamps, helper text, disabled',
    },
    danger: {
      hex: '#ff5a5f',
      rgba: 'rgba(255, 90, 95, 1)',
      use: 'missed goal, destructive copy',
    },
    onVolt: {
      hex: '#121408',
      rgba: 'rgba(18, 20, 8, 1)',
      use: 'text on volt background (button labels, count badge)',
    },
  },
  status: {
    success: {
      hex: '#c6f135',
      rgba: 'rgba(198, 241, 53, 1)',
      use: 'ring fill, logged-ok, on-track states',
    },
    warning: {
      hex: '#ffb454',
      rgba: 'rgba(255, 180, 84, 1)',
      use: 'week-end warning (24h left, 0 logs)',
    },
    danger: {
      hex: '#ff5a5f',
      rgba: 'rgba(255, 90, 95, 1)',
      use: 'missed goal (ring missed state, red banner)',
    },
    trackInactive: {
      hex: '#ffffff',
      rgba: 'rgba(255, 255, 255, 0.10)',
      use: 'inactive weekly-ring track',
    },
  },
  reaction: {
    fire: {
      hex: '#ff6b4a',
      rgba: 'rgba(255, 107, 74, 1)',
      use: '🔥 reaction accent',
    },
    clap: {
      hex: '#ffd166',
      rgba: 'rgba(255, 209, 102, 1)',
      use: '👏 reaction accent',
    },
    heart: {
      hex: '#ff4d6d',
      rgba: 'rgba(255, 77, 109, 1)',
      use: '❤️ reaction accent',
    },
    sideEye: {
      hex: '#8e9bae',
      rgba: 'rgba(142, 155, 174, 1)',
      use: '🙄 side-eye reaction accent (added later with reactions)',
    },
  },
};

export const fontStack = {
  ios: 'SF Pro Text / SF Pro Display (system)',
  android: 'Roboto (system)',
  note: 'No embedded fonts in MVP. Use the platform system font; set fontFamily to undefined and rely on fontWeight.',
};

export type TypeStep = { name: string; size: number; lineHeight: number; weight: number; tracking: number; use: string; uppercase?: boolean };
export const typeScale: TypeStep[] = [
  {
    name: 'display', size: 32, lineHeight: 38, weight: 800, tracking: -0.5, use: 'onboarding headlines, big moments',
  },
  {
    name: 'title', size: 24, lineHeight: 30, weight: 700, tracking: -0.3, use: 'screen titles, ring header row',
  },
  {
    name: 'headline', size: 19, lineHeight: 24, weight: 600, tracking: 0, use: 'section headers (feed groups)',
  },
  {
    name: 'body', size: 16, lineHeight: 24, weight: 400, tracking: 0, use: 'paragraphs, feed captions',
  },
  {
    name: 'bodyStrong', size: 16, lineHeight: 24, weight: 600, tracking: 0, use: 'emphasis inside body',
  },
  {
    name: 'caption', size: 13, lineHeight: 18, weight: 400, tracking: 0, use: 'secondary text, names',
  },
  {
    name: 'captionStrong', size: 13, lineHeight: 18, weight: 600, tracking: 0, use: 'button labels on secondary buttons',
  },
  {
    name: 'label', size: 11, lineHeight: 14, weight: 700, tracking: 0.6, use: 'uppercase micro-labels: \'THIS WEEK\', badges, timestamps', uppercase: true,
  },
  {
    name: 'ringNumber', size: 40, lineHeight: 44, weight: 800, tracking: -1, use: 'center of weekly ring (e.g. \'3/5\')',
  },
];

export const spacing = {
  grid: 4,
  sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, xxxl: 32, giant: 40, huge: 48, mega: 64,
  scale: {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 20,
    xxl: 24,
    xxxl: 32,
    giant: 40,
    huge: 48,
    mega: 64,
  },
  screen: {
    paddingX: 16,
    paddingTop: 8,
    sectionGap: 24,
    feedItemGap: 12,
    rowGap: 12,
  },
  safeArea: {
    note: 'respected on all edges; bottom inset reserved for home indicator (min 12pt extra under bottom bar)',
  },
};

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  sheetTop: 24,
  pill: 999,
  circle: '50% of element size',
};

export const icons = {
  lengths: {
    tab: 24,
    navHeader: 22,
    action: 20,
    badge: 14,
    emptyState: 64,
  },
  cameraGlyph: 34,
  stroke: {
    regular: 1.75,
    bold: 2.5,
    fill: 0,
  },
};

export const weeklyRing = {
  outerDiameter: 132,
  trackStroke: 4,
  progressStroke: 12,
  lineCap: 'round',
  trackColor: '#FFFFFF',
  trackColorAlpha: 0.1,
  progressColor: '#C6F135',
  progressMissedColor: '#FF5A5F',
  glowShadow: '0px 0px 20px rgba(198, 241, 53, 0.30)',
  rotationStart: -90,
  centerLayout: 'numeral + label stacked vertically with 4pt gap, centered',
  numeral: {
    text: 'N/7',
    type: 'ringNumber',
    color: '#F4F6EE',
  },
  label: {
    text: 'DAYS THIS WEEK',
    type: 'label',
    color: '#A9B09B',
  },
};

export const cameraButton = {
  tapTarget: 80,
  visualDiameter: 72,
  strokeOuter: 4,
  strokeOuterColor: '#FFFFFF',
  strokeOuterAlpha: 0.85,
  fill: '#C6F135',
  lensDiameter: 30,
  lensColor: '#FFFFFF',
  glyph: 'camera icon, stroke 2.5, color #121408',
  shadow: '0px 8px 24px rgba(0,0,0,0.50), 0px 0px 24px rgba(198,241,53,0.35)',
  pressedScale: 0.96,
  pressedDurationMs: 90,
  badge: {
    diameter: 22,
    offsetFromEdge: {
      x: -2,
      y: -2,
    },
    background: '#C6F135',
    border: '1px solid #0A0C08',
    text: {
      type: 'captionStrong',
      size: 12,
      color: '#121408',
    },
    visibleWhen: 'week log count >= 1; hidden at 0',
    counts: 'logs this week (same value the ring numeral shows)',
  },
};

export const buttons = {
  primary: {
    height: 56,
    radius: 16,
    background: '#C6F135',
    label: {
      type: 'bodyStrong',
      color: '#121408',
    },
    shadow: '0px 4px 16px rgba(198, 241, 53, 0.25)',
    pressedBackground: 'rgba(198, 241, 53, 0.85)',
  },
  secondary: {
    height: 52,
    radius: 16,
    background: '#1B1F15',
    border: '1px solid rgba(255,255,255,0.12)',
    label: {
      type: 'captionStrong',
      color: '#F4F6EE',
    },
  },
  ghost: {
    height: 44,
    radius: 12,
    background: 'transparent',
    label: {
      type: 'captionStrong',
      color: '#A9B09B',
    },
  },
  chip: {
    height: 36,
    radius: 18,
    background: '#1B1F15',
    selectedBackground: '#C6F135',
    selectedLabel: '#121408',
    unselectedLabel: '#F4F6EE',
    border: '1px solid rgba(255,255,255,0.10)',
    gap: 8,
  },
};

export const statusColors = {
  loggedOk: {
    dot: '#C6F135',
    label: '#A9B09B',
  },
  missed: {
    dot: '#FF5A5F',
    label: '#FF5A5F',
  },
  pending: {
    dot: '#6C7360',
    label: '#6C7360',
  },
};

export const shadows = {
  card: '0px 2px 12px rgba(0, 0, 0, 0.35)',
  tabBar: '0px -2px 16px rgba(0, 0, 0, 0.40)',
  camera: '0px 8px 24px rgba(0,0,0,0.50), 0px 0px 24px rgba(198,241,53,0.35)',
};

export const motion = {
  pageTransitionMs: 250,
  ringFillMs: 400,
  ringFillEasing: 'cubic-bezier(0.22, 1, 0.36, 1)',
  pressMs: 90,
  reactionPopMs: 180,
};

// ---- Derived aliases (tokens.md): success == brand.primary, onVolt == brand.onPrimary ----
export const success = colors.status.success;
export const onVolt = colors.text.onVolt;
export const trackInactive = colors.status.trackInactive;

export const tokens = {
  meta, colors, fontStack, typeScale, spacing, radius, icons, weeklyRing, cameraButton, buttons, statusColors, shadows, motion,
};

export type Tokens = typeof tokens;

export default tokens;
