import { postgresAdapter } from '@payloadcms/db-postgres'
import { buildConfig } from 'payload'
import { attributionPlugin } from 'payload-plugin-attribution'

export default buildConfig({
  db: postgresAdapter({ pool: { connectionString: process.env.DATABASE_URL } }),
  // Runs the plugin's queue every minute and enqueues the scheduled sweep.
  jobs: { autoRun: [{ cron: '* * * * *', queue: 'attribution' }] },
  plugins: [
    attributionPlugin({
      destinations: {
        ga4: {
          apiSecret: process.env.GA4_API_SECRET ?? '',
          measurementId: process.env.GA4_MEASUREMENT_ID ?? '',
        },
      },
      secret: process.env.ATTRIBUTION_SECRET ?? '',
      sweep: { cron: '*/10 * * * *' },
    }),
  ],
  secret: process.env.PAYLOAD_SECRET ?? '',
})
