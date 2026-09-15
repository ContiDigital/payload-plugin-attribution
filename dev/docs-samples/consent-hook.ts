import { attributionProxy } from 'payload-plugin-attribution/next'

// The hook reads the host's consent cookie. It replaces the Sec-GPC default entirely, so it
// must honor Global Privacy Control itself.
export const attribution = attributionProxy({
  consent: (request) => {
    const choice = /(?:^|;\s*)site_consent=(\w+)/.exec(request.headers.get('cookie') ?? '')?.[1]
    if (choice === 'none' || request.headers.get('sec-gpc') === '1') {
      return 'denied'
    }
    return choice === 'all' ? 'granted' : 'unknown'
  },
  siteHosts: ['.example.com'],
})
