import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

type DomainEvent = {
  id: number
  organization_id: number
  branch_id: number
  event_name: string
  payload: Record<string, unknown>
  attempts: number
}

const supabaseUrl = Deno.env.get('SUPABASE_URL')
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false },
})

async function processEvent(event: DomainEvent): Promise<void> {
  switch (event.event_name) {
    case 'OrderCompleted':
    case 'HighValueOrder':
    case 'InventoryImported':
    case 'ExpenseCreated':
    case 'OrderRefunded':
    case 'ShiftOpened':
    case 'ShiftClosed':
    case 'InventoryAdjustmentApproved':
    case 'InventoryAdjustmentRejected':
    case 'SupplierDebtPaid':
    case 'PriceChangeRequested':
    case 'PriceChangeRejected':
    case 'PriceChanged':
    case 'OrderItemCancelled':
    case 'OrderRefundAlert':
    case 'ExpenseAlert':
    case 'ApprovalRequested':
    case 'ApprovalRejected':
    case 'ApprovalExecuted':
      // Minimal production-safe handler:
      // domain_events already has the immutable audit payload. External delivery
      // integrations (email, Zalo, webhook, analytics) should be added here.
      console.log(JSON.stringify({
        event_id: event.id,
        event_name: event.event_name,
        organization_id: event.organization_id,
        branch_id: event.branch_id,
        payload: event.payload,
      }))
      return

    default:
      console.log(JSON.stringify({
        event_id: event.id,
        event_name: event.event_name,
        skipped: true,
      }))
      return
  }
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  const limit = Math.min(
    Number(new URL(request.url).searchParams.get('limit') ?? '25'),
    100,
  )

  const { data: events, error: selectError } = await supabase
    .from('domain_events')
    .select('id, organization_id, branch_id, event_name, payload, attempts')
    .in('status', ['pending', 'failed'])
    .lt('attempts', 5)
    .order('created_at', { ascending: true })
    .limit(limit)

  if (selectError) {
    return Response.json({ error: selectError.message }, { status: 500 })
  }

  const results: Array<{ id: number; status: 'done' | 'failed'; error?: string }> = []

  for (const event of (events ?? []) as DomainEvent[]) {
    const { error: claimError } = await supabase
      .from('domain_events')
      .update({
        status: 'processing',
        attempts: event.attempts + 1,
        last_error: null,
      })
      .eq('id', event.id)
      .in('status', ['pending', 'failed'])

    if (claimError) {
      results.push({ id: event.id, status: 'failed', error: claimError.message })
      continue
    }

    try {
      await processEvent(event)

      const { error: doneError } = await supabase
        .from('domain_events')
        .update({
          status: 'done',
          processed_at: new Date().toISOString(),
          last_error: null,
        })
        .eq('id', event.id)

      if (doneError) throw doneError
      results.push({ id: event.id, status: 'done' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)

      await supabase
        .from('domain_events')
        .update({
          status: 'failed',
          last_error: message,
        })
        .eq('id', event.id)

      results.push({ id: event.id, status: 'failed', error: message })
    }
  }

  return Response.json({
    processed: results.length,
    results,
  })
})

