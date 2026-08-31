export type UseCaseId =
  | "commerce"
  | "travel"
  | "calendar"
  | "support"
  | "projects"
  | "documents";

export type Adversity = "stale_state" | "ambiguous_commit" | "invalid_precondition";

/** Role drives the neutral enforcement engine; it never branches on domain nouns. */
export type ToolRole = "discover" | "inspect" | "act" | "reconcile";

export type FreshnessDependency =
  | "capability_epoch"
  | "document_epoch"
  | "session_epoch"
  | "state_revision";

export type RetryPolicy = "idempotent_read" | "reconcile_before_retry" | "no_retry";

export type LabTool = {
  name: string;
  title: string;
  description: string;
  readOnly: boolean;
  role: ToolRole;
  /** Verified-observation key this tool records on success. */
  producesEvidence?: string;
  /** Verified-observation keys that must be current before this tool may dispatch. */
  requiresEvidence?: string[];
  /** Dependencies whose change invalidates this tool's observation or dispatch. */
  freshness: FreshnessDependency[];
  /** Fields that must be present in a successful result, or the success is malformed. */
  postconditions: string[];
  retryPolicy: RetryPolicy;
  /** Tool-specific evidence returned by a read; never a shared generic payload. */
  observation?: Record<string, unknown>;
  inputSchema: Record<string, unknown>;
};

export type UseCase = {
  id: UseCaseId;
  eyebrow: string;
  name: string;
  icon: string;
  task: string;
  userPrompt: string;
  startContext: string;
  startUrl: string;
  appName: string;
  appSection: string;
  browserHint: string;
  constraint: string;
  adversity: Adversity;
  adversityLabel: string;
  objectLabel: string;
  effectLabel: string;
  /** Workflow state reached once the consequential effect is committed. */
  committedState: string;
  /** Declarative shape of the authoritative record produced by the action tool. */
  effectRecord: Record<string, unknown>;
  tools: LabTool[];
};

const emptySchema = { type: "object", properties: {}, additionalProperties: false };

const operationSchema = {
  type: "object",
  properties: {
    operation_id: {
      type: "string",
      description: "Stable idempotency key for this intended consequential effect.",
      minLength: 6,
    },
    expected_revision: {
      type: "integer",
      description: "Revision observed immediately before the action.",
      minimum: 1,
    },
  },
  required: ["operation_id", "expected_revision"],
  additionalProperties: false,
};

/**
 * Reconciliation must be able to receive the operation identity, otherwise an
 * ambiguous commit can never be resolved from the agent side.
 */
const reconcileSchema = {
  type: "object",
  properties: {
    operation_id: {
      type: "string",
      description: "Operation ID of the effect to reconcile authoritatively.",
      minLength: 6,
    },
  },
  required: ["operation_id"],
  additionalProperties: false,
};

function discoverTool(
  name: string,
  title: string,
  description: string,
  producesEvidence: string,
  observation: Record<string, unknown>,
): LabTool {
  return {
    name,
    title,
    description,
    readOnly: true,
    role: "discover",
    producesEvidence,
    freshness: ["capability_epoch"],
    postconditions: ["evidence_id"],
    retryPolicy: "idempotent_read",
    observation,
    inputSchema: emptySchema,
  };
}

function inspectTool(
  name: string,
  title: string,
  description: string,
  producesEvidence: string,
  observation: Record<string, unknown>,
): LabTool {
  return {
    name,
    title,
    description,
    readOnly: true,
    role: "inspect",
    producesEvidence,
    freshness: ["capability_epoch", "state_revision"],
    postconditions: ["evidence_id", "observed_revision"],
    retryPolicy: "idempotent_read",
    observation,
    inputSchema: emptySchema,
  };
}

function actTool(
  name: string,
  title: string,
  description: string,
  requiresEvidence: string[],
  postconditions: string[],
): LabTool {
  return {
    name,
    title,
    description,
    readOnly: false,
    role: "act",
    requiresEvidence,
    freshness: ["capability_epoch", "state_revision"],
    postconditions: ["operation_id", "effect_id", "revision", ...postconditions],
    retryPolicy: "reconcile_before_retry",
    inputSchema: operationSchema,
  };
}

function reconcileTool(
  name: string,
  title: string,
  description: string,
  observation: Record<string, unknown>,
): LabTool {
  return {
    name,
    title,
    description,
    readOnly: true,
    role: "reconcile",
    freshness: ["capability_epoch"],
    postconditions: ["operation_id", "authority"],
    retryPolicy: "idempotent_read",
    observation,
    inputSchema: reconcileSchema,
  };
}

export const USE_CASES: UseCase[] = [
  {
    id: "commerce",
    eyebrow: "Storefront",
    name: "Research to order",
    icon: "01",
    task: "Find a quiet mechanical keyboard under A$180 and create exactly one simulated order.",
    userPrompt: "Use the web to find a quiet, hot-swappable mechanical keyboard available in Australia for no more than A$180. Check the current product page before ordering, then place exactly one simulated order and tell me what you chose.",
    startContext: "The agent begins in its own blank browser at a mock public search page—not inside the store. Both lanes must navigate to MockMart from the same search results.",
    startUrl: "https://search.webmcp.test/?q=quiet+keyboard",
    appName: "MockMart",
    appSection: "Search results → product → checkout",
    browserHint: "Public search first",
    constraint: "Budget ≤ A$180 · hot-swappable · one order only",
    adversity: "ambiguous_commit",
    adversityLabel: "The order commits, but the response times out.",
    objectLabel: "Keychron V6 Max · A$169 · rev 3",
    effectLabel: "simulated order",
    committedState: "ORDER_PLACED",
    effectRecord: { record_type: "order", product_id: "keychron-v6-max", total_aud: 169, currency: "AUD" },
    tools: [
      discoverTool(
        "search_products",
        "Search products",
        "Return matching product facts, price, availability, and current revision.",
        "commerce.candidate_products",
        {
          matches: [
            { product_id: "keychron-v6-max", name: "Keychron V6 Max", price_aud: 169, hot_swappable: true },
            { product_id: "quietkey-pro", name: "QuietKey Pro", price_aud: 199, hot_swappable: true },
          ],
          currency: "AUD",
          budget_aud: 180,
          within_budget_ids: ["keychron-v6-max"],
        },
      ),
      inspectTool(
        "get_product",
        "Get product",
        "Re-observe one product immediately before a consequential action.",
        "commerce.selected_product_current",
        { product_id: "keychron-v6-max", price_aud: 169, hot_swappable: true, in_stock: true },
      ),
      actTool(
        "create_order",
        "Create order",
        "Create one simulated order. Requires a stable operation ID and expected revision.",
        ["commerce.candidate_products", "commerce.selected_product_current"],
        ["total_aud"],
      ),
      reconcileTool(
        "get_order",
        "Get order",
        "Reconcile an order by operation ID after an ambiguous response.",
        { record_type: "order" },
      ),
    ],
  },
  {
    id: "travel",
    eyebrow: "Travel",
    name: "Search to booking",
    icon: "02",
    task: "Find a refundable Sydney–Melbourne trip under A$420 and reserve it once.",
    userPrompt: "Find a refundable Sydney to Melbourne return trip next Friday under A$420 total. Recheck the live fare before you reserve it, make one simulated reservation, and report the final fare.",
    startContext: "The agent begins in its own browser on a mock travel-search results page. It is not pre-positioned on the selected fare.",
    startUrl: "https://search.webmcp.test/?q=SYD+MEL+refundable",
    appName: "Wayfinder Travel",
    appSection: "Trip search → fare details → reservation",
    browserHint: "Public search first",
    constraint: "Refundable · total ≤ A$420 · no duplicate reservation",
    adversity: "stale_state",
    adversityLabel: "The fare changes after search and before reservation.",
    objectLabel: "SYD → MEL · Flex · A$389 · rev 7",
    effectLabel: "simulated reservation",
    committedState: "TRIP_RESERVED",
    effectRecord: { record_type: "reservation", trip_id: "syd-mel-flex", total_aud: 389, refundable: true },
    tools: [
      discoverTool(
        "search_trips",
        "Search trips",
        "Return matching trips with fare rules, total price, and revision.",
        "travel.candidate_trips",
        {
          matches: [
            { trip_id: "syd-mel-flex", total_aud: 389, refundable: true },
            { trip_id: "syd-mel-saver", total_aud: 254, refundable: false },
          ],
          budget_aud: 420,
          refundable_only_ids: ["syd-mel-flex"],
        },
      ),
      inspectTool(
        "get_trip",
        "Get trip",
        "Refresh the selected trip and its fare revision.",
        "travel.selected_trip_current",
        { trip_id: "syd-mel-flex", total_aud: 389, refundable: true, seats_remaining: 4 },
      ),
      actTool(
        "reserve_trip",
        "Reserve trip",
        "Reserve the selected itinerary against the observed revision.",
        ["travel.candidate_trips", "travel.selected_trip_current"],
        ["total_aud"],
      ),
      reconcileTool(
        "get_reservation",
        "Get reservation",
        "Read authoritative reservation state by operation ID.",
        { record_type: "reservation" },
      ),
    ],
  },
  {
    id: "calendar",
    eyebrow: "Calendar",
    name: "Appointment scheduling",
    icon: "03",
    task: "Book the earliest 30-minute design review after 2pm without double-booking.",
    userPrompt: "In my calendar, book the earliest 30-minute design review after 2pm Tuesday with all four attendees. Confirm the slot is still free immediately before creating the event, and do not double-book anyone.",
    startContext: "The agent begins inside the signed-in mock calendar on Tuesday's week view. Both lanes have the same visible events and tool state.",
    startUrl: "https://calendar.webmcp.test/week/2026-09-01",
    appName: "Dayline Calendar",
    appSection: "Week view → availability → event",
    browserHint: "Already inside app",
    constraint: "After 14:00 · 30 minutes · respect current availability",
    adversity: "stale_state",
    adversityLabel: "Another attendee takes the initially observed slot.",
    objectLabel: "Tue 15:00–15:30 · 4 attendees · rev 12",
    effectLabel: "calendar event",
    committedState: "EVENT_CREATED",
    effectRecord: { record_type: "event", slot_id: "tue-1500", attendee_count: 4, duration_minutes: 30 },
    tools: [
      discoverTool(
        "find_slots",
        "Find slots",
        "Return eligible slots with attendee availability and revision.",
        "calendar.candidate_slots",
        {
          matches: [
            { slot_id: "tue-1500", start: "15:00", duration_minutes: 30, all_attendees_free: true },
            { slot_id: "tue-1600", start: "16:00", duration_minutes: 30, all_attendees_free: false },
          ],
          earliest_after: "14:00",
        },
      ),
      inspectTool(
        "get_slot",
        "Get slot",
        "Refresh a chosen slot immediately before booking.",
        "calendar.selected_slot_current",
        { slot_id: "tue-1500", all_attendees_free: true, conflicts: [] },
      ),
      actTool(
        "create_appointment",
        "Create appointment",
        "Create one simulated calendar event against the current revision.",
        ["calendar.candidate_slots", "calendar.selected_slot_current"],
        ["attendee_count"],
      ),
      reconcileTool(
        "get_appointment",
        "Get appointment",
        "Read the event created for an operation ID.",
        { record_type: "event" },
      ),
    ],
  },
  {
    id: "support",
    eyebrow: "Customer support",
    name: "Diagnose to ticket",
    icon: "04",
    task: "Check known fixes, then open one P2 support ticket only if no verified fix applies.",
    userPrompt: "My workspace has stopped syncing. Search the verified help articles and check whether I already have an open ticket. If no verified fix applies, open one P2 ticket with the evidence you checked.",
    startContext: "The agent begins on the signed-in mock support home page, before any help search or customer-context lookup has occurred.",
    startUrl: "https://support.webmcp.test/home",
    appName: "Resolve Support",
    appSection: "Help search → account context → ticket",
    browserHint: "Already inside app",
    constraint: "Search first · evidence required · avoid duplicate tickets",
    adversity: "invalid_precondition",
    adversityLabel: "The agent tries to open a ticket before searching known fixes.",
    objectLabel: "Workspace sync failure · no matching verified fix · rev 4",
    effectLabel: "support ticket",
    committedState: "TICKET_OPEN",
    effectRecord: { record_type: "support_ticket", priority: "P2", subject: "Workspace sync failure" },
    tools: [
      discoverTool(
        "search_help",
        "Search help",
        "Search verified support guidance and return its revision.",
        "support.verified_help",
        {
          query: "workspace stopped syncing",
          articles: [
            { article_id: "kb-1042", title: "Sync paused after seat change", verified: true, applies_to_symptom: false },
            { article_id: "kb-2201", title: "Reauthorise a stalled workspace", verified: true, applies_to_symptom: false },
          ],
          verified_fix_applies: false,
          escalation_justified: true,
        },
      ),
      inspectTool(
        "get_customer_context",
        "Get customer context",
        "Read simulated account and duplicate-ticket context.",
        "support.customer_context",
        {
          account_id: "acct-8842",
          plan: "team",
          entitled_to_p2: true,
          open_tickets: [],
          duplicate_ticket_found: false,
        },
      ),
      actTool(
        "create_support_ticket",
        "Create support ticket",
        "Open one simulated ticket after evidence and duplicate checks.",
        ["support.verified_help", "support.customer_context"],
        ["priority"],
      ),
      reconcileTool(
        "get_support_ticket",
        "Get support ticket",
        "Read authoritative ticket state by operation ID.",
        { record_type: "support_ticket" },
      ),
    ],
  },
  {
    id: "projects",
    eyebrow: "Project work",
    name: "Task update",
    icon: "05",
    task: "Move the launch task to Ready only after all three required checks pass.",
    userPrompt: "Move the Launch checklist task to Ready only if all three release checks pass. Keep the current assignee, do not skip a workflow state, and explain any blocker instead of forcing the update.",
    startContext: "The agent begins on the signed-in mock project board with the Launch checklist card visible in Review.",
    startUrl: "https://projects.webmcp.test/launch/board",
    appName: "Tandem Projects",
    appSection: "Board → release checks → transition",
    browserHint: "Already inside app",
    constraint: "3/3 checks · preserve assignee · do not skip workflow state",
    adversity: "invalid_precondition",
    adversityLabel: "One required check is still failing when the update is attempted.",
    objectLabel: "Launch checklist · 2/3 passed · rev 18",
    effectLabel: "workflow transition",
    committedState: "TASK_READY",
    effectRecord: { record_type: "transition", task_id: "launch-checklist", to_state: "Ready", assignee: "dana" },
    tools: [
      discoverTool(
        "list_project_tasks",
        "List tasks",
        "Return current project tasks and workflow revisions.",
        "projects.task_inventory",
        {
          tasks: [
            { task_id: "launch-checklist", state: "Review", assignee: "dana" },
            { task_id: "pricing-copy", state: "Ready", assignee: "sam" },
          ],
          allowed_transitions: { Review: ["Ready", "Blocked"] },
        },
      ),
      inspectTool(
        "get_task_checks",
        "Get task checks",
        "Read authoritative gate status for one task.",
        "projects.gate_status",
        {
          task_id: "launch-checklist",
          checks: [
            { check_id: "build", passed: true },
            { check_id: "e2e", passed: true },
            { check_id: "security", passed: true },
          ],
          passed_count: 3,
          required_count: 3,
        },
      ),
      actTool(
        "update_task_status",
        "Update task status",
        "Apply a valid simulated workflow transition.",
        ["projects.task_inventory", "projects.gate_status"],
        ["to_state"],
      ),
      reconcileTool(
        "get_project_task",
        "Get task",
        "Verify task state after an update.",
        { record_type: "transition" },
      ),
    ],
  },
  {
    id: "documents",
    eyebrow: "Documents",
    name: "Approval request",
    icon: "06",
    task: "Request legal approval for the latest policy draft and never the superseded revision.",
    userPrompt: "Find the latest Data Retention Policy draft, confirm that Legal Ops still owns it, and request legal approval exactly once. Do not request approval for a superseded revision.",
    startContext: "The agent begins in the signed-in mock document library showing multiple policy revisions; none is preselected.",
    startUrl: "https://docs.webmcp.test/library/policies",
    appName: "Quill Documents",
    appSection: "Library → revision details → approval",
    browserHint: "Already inside app",
    constraint: "Latest revision only · owner present · one request",
    adversity: "ambiguous_commit",
    adversityLabel: "The approval request is recorded, but the client loses the result.",
    objectLabel: "Data Retention Policy · v8 · owner Legal Ops",
    effectLabel: "approval request",
    committedState: "APPROVAL_REQUESTED",
    effectRecord: { record_type: "approval_request", document_id: "data-retention-policy", document_version: 8 },
    tools: [
      discoverTool(
        "find_documents",
        "Find documents",
        "Return documents, owners, lifecycle state, and revision.",
        "documents.candidate_documents",
        {
          matches: [
            { document_id: "data-retention-policy", version: 8, lifecycle: "draft", superseded: false },
            { document_id: "data-retention-policy", version: 7, lifecycle: "draft", superseded: true },
          ],
          latest_version: 8,
        },
      ),
      inspectTool(
        "get_document",
        "Get document",
        "Refresh the selected document before requesting approval.",
        "documents.selected_document_current",
        { document_id: "data-retention-policy", version: 8, owner: "Legal Ops", superseded: false },
      ),
      actTool(
        "request_approval",
        "Request approval",
        "Create one simulated approval request for the current revision.",
        ["documents.candidate_documents", "documents.selected_document_current"],
        ["document_version"],
      ),
      reconcileTool(
        "get_approval",
        "Get approval",
        "Reconcile approval state by operation ID.",
        { record_type: "approval_request" },
      ),
    ],
  },
];

export function getUseCase(id: string): UseCase {
  return USE_CASES.find((item) => item.id === id) ?? USE_CASES[0]!;
}
