import '@payloadcms/next/css'

import type { ServerFunctionClient } from 'payload'
import type { ReactNode } from 'react'

import { handleServerFunctions, RootLayout } from '@payloadcms/next/layouts'

import config from '../../payload.config.js'
import { importMap } from './admin/importMap.js'
const serverFunction: ServerFunctionClient = async (args) => {
  'use server'
  return handleServerFunctions({ ...args, config, importMap })
}
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <RootLayout config={config} importMap={importMap} serverFunction={serverFunction}>
      {children}
    </RootLayout>
  )
}
