import React from 'react';
import { Platform } from 'react-native';
import FitImage from 'react-native-fit-image';
import { MarkdownIt, RenderRules } from 'react-native-markdown-display';
import { colors } from './theme';

// linkify is off by default in markdown-it, but we pin it explicitly rather
// than relying on that default: the bundled linkify-it has an unpatched
// ReDoS in its autolink scanner (GHSA-v245-v573-v5vm), and this app renders
// text that ultimately originates from scanned barcode data / MCP tool
// output, not just Claude's own prose. We don't need bare-URL autolinking —
// Claude already emits proper [text](url) links — so keep the vulnerable
// code path unreachable rather than just noting the risk.
export const markdownItInstance = MarkdownIt({ typographer: true, linkify: false });

// Override just the `image` rule: the library's default builds a props
// object that includes `key` and spreads it into <FitImage {...props} />,
// which React 19 warns on ("key must be passed directly to JSX, not via
// spread"). Same behavior, `key` passed as a real JSX attribute instead.
export const markdownRules: RenderRules = {
  image: (node, _children, _parent, styles, allowedImageHandlers, defaultImageHandler) => {
    const { src, alt } = node.attributes;
    const show = allowedImageHandlers.some((handler) => src.toLowerCase().startsWith(handler.toLowerCase()));
    if (!show && !defaultImageHandler) return null;
    return (
      <FitImage
        key={node.key}
        indicator
        style={styles._VIEW_SAFE_image}
        source={{ uri: show ? src : `${defaultImageHandler}${src}` }}
        {...(alt ? { accessible: true, accessibilityLabel: alt } : {})}
      />
    );
  },
};

const monoFont = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

export const markdownStyles = {
  body: { color: colors.text, fontSize: 16, lineHeight: 23 },
  heading1: { color: colors.text, fontSize: 22, fontWeight: '700' as const, marginTop: 4, marginBottom: 6 },
  heading2: { color: colors.text, fontSize: 19, fontWeight: '700' as const, marginTop: 4, marginBottom: 6 },
  heading3: { color: colors.text, fontSize: 17, fontWeight: '700' as const, marginTop: 4, marginBottom: 4 },
  heading4: { color: colors.text, fontSize: 16, fontWeight: '700' as const, marginTop: 4, marginBottom: 4 },
  heading5: { color: colors.text, fontSize: 15, fontWeight: '700' as const, marginTop: 4, marginBottom: 4 },
  heading6: { color: colors.text, fontSize: 14, fontWeight: '700' as const, marginTop: 4, marginBottom: 4 },
  hr: { backgroundColor: colors.border, height: 1, marginVertical: 8 },
  strong: { fontWeight: '700' as const },
  em: { fontStyle: 'italic' as const },
  s: { textDecorationLine: 'line-through' as const, color: colors.textDim },
  blockquote: {
    backgroundColor: colors.surfaceAlt,
    borderLeftColor: colors.accent,
    borderLeftWidth: 3,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 4,
    marginVertical: 6,
  },
  bullet_list: { marginVertical: 4 },
  ordered_list: { marginVertical: 4 },
  list_item: { flexDirection: 'row' as const, justifyContent: 'flex-start' as const, marginBottom: 4 },
  bullet_list_icon: { color: colors.accent, marginLeft: 4, marginRight: 8 },
  bullet_list_content: { flex: 1, color: colors.text },
  ordered_list_icon: { color: colors.accent, marginLeft: 4, marginRight: 8 },
  ordered_list_content: { flex: 1, color: colors.text },
  code_inline: {
    backgroundColor: colors.surfaceAlt,
    color: colors.accent,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 1,
    fontFamily: monoFont,
  },
  code_block: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    color: colors.text,
    fontFamily: monoFont,
  },
  fence: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    color: colors.text,
    fontFamily: monoFont,
  },
  table: { borderColor: colors.border, borderWidth: 1, borderRadius: 6, marginVertical: 6 },
  th: { flex: 1, padding: 6, color: colors.text, fontWeight: '700' as const },
  tr: { borderBottomWidth: 1, borderColor: colors.border, flexDirection: 'row' as const },
  td: { flex: 1, padding: 6, color: colors.text },
  link: { color: colors.accent, textDecorationLine: 'underline' as const },
  paragraph: { marginTop: 0, marginBottom: 8, flexWrap: 'wrap' as const, width: '100%' as const },
};
