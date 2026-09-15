'use client'

import { attributionForSubmit } from 'payload-plugin-attribution/browser'
import { useActionState } from 'react'

import type { LeadState } from './actions.js'

import { submitLead } from './actions.js'

const initialState: LeadState = { status: 'idle' }

export function LeadForm() {
  const [state, action, pending] = useActionState(
    async (previous: LeadState, formData: FormData) => {
      formData.set('attribution', JSON.stringify(await attributionForSubmit()))
      return submitLead(previous, formData)
    },
    initialState,
  )

  return (
    <form action={action} aria-labelledby="lead-heading">
      <h2 id="lead-heading">Request a callback</h2>
      <p>
        <label htmlFor="lead-name" id="lead-name-label">
          Name
        </label>
        <br />
        <input
          aria-labelledby="lead-name-label"
          autoComplete="name"
          id="lead-name"
          name="name"
          required
        />
      </p>
      <p>
        <label htmlFor="lead-email" id="lead-email-label">
          Email
        </label>
        <br />
        <input
          aria-labelledby="lead-email-label"
          autoComplete="email"
          id="lead-email"
          name="email"
          required
          type="email"
        />
      </p>
      <p>
        <label htmlFor="lead-message" id="lead-message-label">
          Message
        </label>
        <br />
        <textarea aria-labelledby="lead-message-label" id="lead-message" name="message" rows={3} />
      </p>
      <button disabled={pending} type="submit">
        {pending ? 'Sending...' : 'Send request'}
      </button>
      <p aria-live="polite" role="status">
        {state.status === 'sent' ? `Thanks, we received request ${state.reference}.` : null}
        {state.status === 'error' ? state.message : null}
      </p>
    </form>
  )
}
