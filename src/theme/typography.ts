/**
 * Typography primitives — the 9-step type scale from tokens (pt, system fonts).
 * No custom fonts (tokens.md): rely on fontWeight; fontFamily stays unset.
 */
import { createTextStyle, type TextStyleFactory } from './createTextStyle';
import { colors } from './tokens';

export type TypographyVariant =
  | 'display'
  | 'title'
  | 'headline'
  | 'body'
  | 'bodyStrong'
  | 'caption'
  | 'captionStrong'
  | 'label'
  | 'ringNumber';

export interface TypographyProps {
  variant?: TypographyVariant;
  color?: string;
  uppercase?: boolean;
  style?: TextStyleFactory['style'];
}

function textStyleFor(variant: TypographyVariant) {
  switch (variant) {
    case 'display':
      return {
        fontSize: 32,
        lineHeight: 38,
        fontWeight: '800' as const,
        letterSpacing: -0.5,
      };
    case 'title':
      return {
        fontSize: 24,
        lineHeight: 30,
        fontWeight: '700' as const,
        letterSpacing: -0.3,
      };
    case 'headline':
      return {
        fontSize: 19,
        lineHeight: 24,
        fontWeight: '600' as const,
        letterSpacing: 0,
      };
    case 'body':
      return { fontSize: 16, lineHeight: 24, fontWeight: '400' as const, letterSpacing: 0 };
    case 'bodyStrong':
      return { fontSize: 16, lineHeight: 24, fontWeight: '600' as const, letterSpacing: 0 };
    case 'caption':
      return { fontSize: 13, lineHeight: 18, fontWeight: '400' as const, letterSpacing: 0 };
    case 'captionStrong':
      return { fontSize: 13, lineHeight: 18, fontWeight: '600' as const, letterSpacing: 0 };
    case 'label':
      return {
        fontSize: 11,
        lineHeight: 14,
        fontWeight: '700' as const,
        letterSpacing: 0.6,
        textTransform: 'uppercase' as const,
      };
    case 'ringNumber':
      return {
        fontSize: 40,
        lineHeight: 44,
        fontWeight: '800' as const,
        letterSpacing: -1,
      };
  }
}

export function typography(variant: TypographyVariant): ReturnType<typeof createTextStyle> {
  return createTextStyle(textStyleFor(variant));
}

export const textStyles = {
  display: typography('display'),
  title: typography('title'),
  headline: typography('headline'),
  body: typography('body'),
  bodyStrong: typography('bodyStrong'),
  caption: typography('caption'),
  captionStrong: typography('captionStrong'),
  label: typography('label'),
  ringNumber: typography('ringNumber'),
};

export const typeColors = {
  primary: colors.text.primary.hex,
  secondary: colors.text.secondary.hex,
  muted: colors.text.muted.hex,
  danger: colors.text.danger.hex,
  onVolt: colors.text.onVolt.hex,
};