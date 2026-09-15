import type { PayloadRequest } from 'payload'

import type { AuthorizeScope, NormalizedOptions } from '../../types/index.js'

import { ForbiddenError } from '../utilities/errors.js'
import { createLogger } from '../utilities/logger.js'

// A host authorize callback that throws denies the request instead of failing it.
export const requireScope = async (
  options: Pick<NormalizedOptions, 'authorize'>,
  req: PayloadRequest,
  scope: AuthorizeScope,
): Promise<void> => {
  let allowed = false
  try {
    allowed = (await options.authorize({ req, scope })) === true
  } catch (error) {
    createLogger(req.payload).warn('authorize callback threw; the request is denied', {
      error,
      scope,
    })
  }
  if (!allowed) {
    throw new ForbiddenError('forbidden')
  }
}
