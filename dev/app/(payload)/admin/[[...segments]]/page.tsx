import { generatePageMetadata, RootPage } from '@payloadcms/next/views'

import config from '../../../../payload.config.js'
import { importMap } from '../importMap.js'
type Args = {
  params: Promise<{ segments: string[] }>
  searchParams: Promise<Record<string, string | string[]>>
}
export const generateMetadata = ({ params, searchParams }: Args) =>
  generatePageMetadata({ config, params, searchParams })
export default function Page({ params, searchParams }: Args) {
  return RootPage({ config, importMap, params, searchParams })
}
