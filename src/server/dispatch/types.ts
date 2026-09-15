import type { Config, Payload, PayloadRequest } from 'payload'

import type { NormalizedOptions } from '../../types/index.js'

export type AttributionDispatcher = {
  dispatch: (args: {
    deliveryId: number | string
    notBefore?: Date
    payload: Payload
    req?: PayloadRequest
  }) => Promise<void>
  install?: (config: Config, options: NormalizedOptions) => Config
  name: string
}
