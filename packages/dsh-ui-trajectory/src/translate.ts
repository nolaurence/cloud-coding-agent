import { zh as commonZh } from './common-zh.ts'
import { zh, type TrajectoryTranslate } from './client/locales.ts'

const dictionary: Record<string, string> = { ...commonZh, ...zh }

/** Chinese labels shared by the native trajectory view and its inspectors. */
export const trajectoryTranslate: TrajectoryTranslate = (key, params = {}) => {
  const template = dictionary[key] ?? key
  return template.replace(/\{([^{}]+)\}/g, (_match, name: string) => {
    const value = params[name]
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : ''
  })
}
