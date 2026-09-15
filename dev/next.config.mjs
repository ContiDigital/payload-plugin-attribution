import { withPayload } from '@payloadcms/next/withPayload'
export default withPayload(
  {
    webpack(config) {
      config.resolve.extensionAlias = { '.js': ['.ts', '.tsx', '.js', '.jsx'] }
      return config
    },
  },
  { devBundleServerPackages: false },
)
