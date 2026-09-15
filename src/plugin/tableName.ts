// The SQL adapters name a collection's table with the to-snake-case package; this follows it so
// that two slugs sharing one table are caught at config time.
const HAS_SPACE = /\s/
const HAS_SEPARATOR = /[_\-.:]/
const HAS_CAMEL = /[a-z][A-Z]|[A-Z][a-z]/
const SEPARATORS = /[\W_]+(.|$)/g

const joinWords = (text: string): string =>
  text.replace(SEPARATORS, (_match, next: string) => (next ? ` ${next}` : ''))

const noCase = (text: string): string => {
  if (HAS_SPACE.test(text)) {
    return text.toLowerCase()
  }
  if (HAS_SEPARATOR.test(text)) {
    return (joinWords(text) || text).toLowerCase()
  }
  if (HAS_CAMEL.test(text)) {
    return text
      .replace(
        /(.)([A-Z]+)/g,
        (_match, previous: string, uppers: string) =>
          `${previous} ${uppers.toLowerCase().split('').join(' ')}`,
      )
      .toLowerCase()
  }
  return text.toLowerCase()
}

export const sqlTableName = (slug: string): string =>
  joinWords(noCase(slug)).trim().replace(/\s/g, '_')
