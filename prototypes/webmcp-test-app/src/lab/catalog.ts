export type UseCaseId =
  | "commerce"
  | "travel"
  | "calendar"
  | "support"
  | "projects"
  | "documents";

export type Adversity = "stale_state" | "ambiguous_commit" | "invalid_precondition";

export type LabTool = {
  name: string;
  title: string;
  description: string;
  readOnly: boolean;
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

function readTool(name: string, title: string, description: string): LabTool {
  return { name, title, description, readOnly: true, inputSchema: emptySchema };
}

function actionTool(name: string, title: string, description: string): LabTool {
  return { name, title, description, readOnly: false, inputSchema: operationSchema };
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
    tools: [
      readTool("search_products", "Search products", "Return matching product facts, price, availability, and current revision."),
      readTool("get_product", "Get product", "Re-observe one product immediately before a consequential action."),
      actionTool("create_order", "Create order", "Create one simulated order. Requires a stable operation ID and expected revision."),
      readTool("get_order", "Get order", "Reconcile an order by the current operation ID after an ambiguous response."),
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
    tools: [
      readTool("search_trips", "Search trips", "Return matching trips with fare rules, total price, and revision."),
      readTool("get_trip", "Get trip", "Refresh the selected trip and its fare revision."),
      actionTool("reserve_trip", "Reserve trip", "Reserve the selected itinerary against the observed revision."),
      readTool("get_reservation", "Get reservation", "Read authoritative reservation state by operation ID."),
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
    tools: [
      readTool("find_slots", "Find slots", "Return eligible slots with attendee availability and revision."),
      readTool("get_slot", "Get slot", "Refresh a chosen slot immediately before booking."),
      actionTool("create_appointment", "Create appointment", "Create one simulated calendar event against the current revision."),
      readTool("get_appointment", "Get appointment", "Read the event created for an operation ID."),
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
    tools: [
      readTool("search_help", "Search help", "Search verified support guidance and return its revision."),
      readTool("get_customer_context", "Get customer context", "Read simulated account and duplicate-ticket context."),
      actionTool("create_support_ticket", "Create support ticket", "Open one simulated ticket after evidence and duplicate checks."),
      readTool("get_support_ticket", "Get support ticket", "Read ticket state by operation ID."),
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
    tools: [
      readTool("list_project_tasks", "List tasks", "Return current project tasks and workflow revisions."),
      readTool("get_task_checks", "Get task checks", "Read authoritative gate status for one task."),
      actionTool("update_task_status", "Update task status", "Apply a valid simulated workflow transition."),
      readTool("get_project_task", "Get task", "Verify task state after an update."),
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
    tools: [
      readTool("find_documents", "Find documents", "Return documents, owners, lifecycle state, and revision."),
      readTool("get_document", "Get document", "Refresh the selected document before requesting approval."),
      actionTool("request_approval", "Request approval", "Create one simulated approval request for the current revision."),
      readTool("get_approval", "Get approval", "Reconcile approval state by operation ID."),
    ],
  },
];

export function getUseCase(id: string): UseCase {
  return USE_CASES.find((item) => item.id === id) ?? USE_CASES[0]!;
}
