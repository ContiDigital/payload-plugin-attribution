import type { Metadata } from 'next'

import { LeadForm } from './lead/LeadForm.js'

export const metadata: Metadata = { title: 'Attribution development app' }

export default function Page() {
  return (
    <main>
      <h1>Attribution development app</h1>
      <p>
        Visits through the proxy store first and last touches in a first-party cookie. Submitting
        the form records a lead conversion and delivers it to the configured destinations.
      </p>
      <LeadForm />
      <p>
        <a href="/admin">Open the conversion ledger</a>
      </p>
    </main>
  )
}
