## 1. Purpose

This guide structures the 2-week analysis phase for designing a Complaint Management bounded context within the Construction Portal. It provides a discovery framework for stakeholder interviews and a comprehensive checklist to ensure nothing critical is missed before development begins.

**Key principle:** Complaints are not tasks. They have their own lifecycle, reporting needs, and audit requirements. They deserve a dedicated bounded context — not a "task type" bolt-on.
## 2. Discovery Framework

### 2.1 As-Is Process Mapping

Before designing the future state, map what actually happens today. For each role in the process chain, gather answers to:

1. How do you currently report or flag a defect/issue? (Email, phone call, note in the system, verbal?)
2. What information do you capture when you find a problem? What do you wish you could capture?
3. How do you know when an issue you raised has been resolved?
4. What happens after a fix is applied? Does the work re-enter the full process chain or just your step?
5. What is the most frustrating part of the current process?
6. How often do you encounter the same type of issue repeatedly?
7. Do you track complaints in any personal system (spreadsheet, notes)?

### 2.2 Stakeholder Interview Map

Prioritize interviews by coverage of the process chain and decision authority:

| Contact            | Role                               | Key Topics to Cover                                                                     |
| ------------------ | ---------------------------------- | --------------------------------------------------------------------------------------- |
| **pan Kopeluk**    | FTTH Manager / Coordinator         | Overall process, escalation paths, reporting needs, SLA expectations. Careful handling. |
| **Martin Dvořák**  | Output Control (Výstupní kontrola) | Validation gate requirements, most common defect types, photo/evidence handling         |
| **Petr Nedvěd**    | Head of Technicians & Dispatchers  | Resolution workflow, resource allocation, re-inspection process                         |
| **Tomáš Kůrka**    | Dispatcher                         | Day-to-day complaint flow, communication gaps, tooling pain points                      |
| **Pavel Kadlec**   | KPS 1                              | Construction-phase defects, handover quality, contractor issues                         |
| **Jarda Brož**     | KPS 4                              | Field-level defect discovery, evidence capture, process re-entry experience             |
| **Benetka**        | APC Contact                        | Post-commerce complaints from operators, SLA requirements, escalation                   |
| **Gába / IS Team** | System / Architecture              | Technical constraints, integration points, data model requirements                      |

### 2.3 Process Chain Re-Entry Analysis

This is the most architecturally significant design question. After a complaint is resolved, the fix must re-enter the process chain. Determine:

- Is it always the full chain, or does it depend on the defect type / severity?
	- Probably yes, shortened variants are not priority right now.
- Which specific process steps are affected by which error categories?
	- Entirety of the chain
- Can some defect types be resolved with a "short loop" (e.g., missing photo → upload → verify) while others require full re-inspection?
	- Maybe yes, but it has to be revieved anyway
- How does re-entry interact with the existing project state machine? Does the project status revert?

### 2.4 Two Complaint Types — Comparison Matrix

Before designing a unified model, compare both complaint types side by side. Fill this in during interviews:

| Dimension                | Construction-Phase | Post-Commerce |
| ------------------------ | ------------------ | ------------- |
| Who triggers it?         |                    |               |
| Trigger event            |                    |               |
| Typical defect types     |                    |               |
| Urgency / SLA            |                    |               |
| Resolution workflow      |                    |               |
| Re-inspection required?  |                    |               |
| Validation / sign-off by |                    |               |
| Affected systems         |                    |               |
| Reporting needs          |                    |               |
| Error taxonomy shared?   |                    |               |

### 2.5 Error Taxonomy Discovery

The error type codelist (číselník typů chyb) is critical for reporting. During interviews:

- Ask field users to recall the last 3–5 defects they encountered and categorize them from memory.
- Check if the current codelist is sufficient — are people always picking "Other"?
- Determine if the taxonomy should be hierarchical (Category → Subcategory → Specific Error).
- Check if construction-phase and post-commerce complaints share the same error types or need distinct branches.

**Candidate top-level categories** (starting point to validate with stakeholders):

- Documentation Defects — missing photos, incomplete forms, wrong metadata
- Construction Quality — bad fiber split, incorrect cable routing, physical damage
- Network Configuration — incorrect network inventory data, wrong port assignment
- Process / Handover — missed handover step, incomplete checklist, wrong status
- Material / Equipment — defective components, wrong specification used
- Safety / Compliance — safety standard violation, regulatory non-compliance

### 2.6 Validation Gate Design

The originator's right to validate the resolution is a key requirement. Clarify:

- **Blocking vs. advisory?** Can the complaint close without the originator's explicit approval, or is it just a notification?
- **Timeout / escalation:** What happens if the originator is unavailable (leave, role change)?
- **Delegate validation:** Can someone else in the same role sign off?
- **Rejection flow:** If the originator rejects, does it go back to investigation or directly to resolution?

### 2.7 Existing Documentation & Artifacts Discovery

Things to look for during interviews and ask for protocols or something:

- **Forms and templates** used when reporting or documenting a defect (paper or digital — Excel sheets, Word templates, internal portal forms)
- **Checklists** used during inspection or handover (výstupní kontrola checklists, KPS handover forms)
- **Email threads or communication templates** — are there standard email formats people use to escalate or report issues?
- **Internal guidelines or SOPs** — any written procedure for handling reklamace, even if outdated or informal
- **Existing codelist documentation** — the current číselník typů chyb, who maintains it, where it lives
- **Reports or dashboards** already being generated from complaint data (even manual ones in Excel)
- **Contract or SLA documents** with suppliers/contractors that define quality requirements and defect handling obligations — these often contain penalty clauses or resolution timeframes that your system will need to support
- **Regulatory or compliance documents** that prescribe how non-conformances must be tracked or reported

---

## 3. Domain Model Outline

This section provides a starting point for the DDD-based bounded context design. Treat it as a hypothesis to refine based on discovery findings — not a final specification.

### 3.1 Bounded Context: Complaint Management (Správa reklamací)

This is a new, dedicated bounded context. It owns the complaint lifecycle and communicates with other contexts via domain events and references by ID. It does **not** own projects, work orders, or network elements — it only points at them.

### 3.2 Aggregate Root: Complaint (Reklamace)

| Attribute          | Type / Description                                                               |
| ------------------ | -------------------------------------------------------------------------------- |
| `complaintId`      | Unique identifier (auto-generated)                                               |
| `type`             | `ConstructionPhase` \| `PostCommerce`                                            |
| `status`           | Lifecycle state (see Section 4)                                                  |
| `severity`         | `Critical` \| `Major` \| `Minor` — drives SLA                                    |
| `errorType`        | Reference to the error taxonomy codelist                                         |
| `originatorRole`   | Who raised it (KPS 4, KPS 1, Dispatcher, Output Control, FTTH Manager, Operator) |
| `originatorId`     | Specific person reference                                                        |
| `subjectReference` | What entity is affected — composite: entity type + entity ID                     |
| `description`      | Free-text description of the issue                                               |
| `evidence`         | List of attachments (photos, documents)                                          |
| `raisedAt`         | Timestamp                                                                        |
| `resolvedAt`       | Timestamp (nullable)                                                             |
| `closedAt`         | Timestamp (nullable)                                                             |
| `rootCause`        | Optional root cause category (for future use)                                    |

### 3.3 Entity: Resolution (Oprava / Nápravné opatření)

|Attribute|Type / Description|
|---|---|
|`resolutionId`|Unique identifier|
|`complaintId`|Parent reference|
|`resolutionType`|`Containment` \| `CorrectiveAction`|
|`description`|What was done|
|`resolvedBy`|Who performed the fix|
|`resolvedAt`|Timestamp|
|`evidence`|Attachments proving the fix|

The distinction between **Containment** (interim fix so work isn't blocked) and **Corrective Action** (permanent fix addressing root cause) comes from the 8D methodology and is especially relevant for construction-phase complaints.

### 3.4 Entity: Validation (Validace)

|Attribute|Type / Description|
|---|---|
|`validationId`|Unique identifier|
|`complaintId`|Parent reference|
|`validatedBy`|The originator (or delegate)|
|`validatedAt`|Timestamp|
|`result`|`Approved` \| `Rejected`|
|`comment`|Optional rejection reason|

### 3.5 Value Objects

- **ErrorType** — from the codelist (číselník typů chyb), with category and subcategory
- **SubjectReference** — composite: entity type (`Project`, `WorkOrder`, `NetworkElement`) + entity ID
- **Attachment** — file reference, upload timestamp, uploader

### 3.6 Integration Points

The Complaint BC references but does not own entities from these existing contexts:

|Existing Context|Integration Pattern|
|---|---|
|**Project Context** (Projektový kontext)|Complaint references a project by ID. Project status may be affected by critical complaints.|
|**Work Order / WBS Context**|Complaint may reference a specific work order or WBS element.|
|**Network Inventory** (Kmenová data)|Complaint may reference a specific network element (e.g., fiber split point).|
|**Process Management** (Řízení projektu)|Process chain re-entry is orchestrated here. Complaint BC emits events; Process context decides which steps to re-run.|
|**User / Role Context**|Originator identity, assignment, permission checks.|

---

## 4. Complaint Lifecycle (State Machine)

### 4.1 States

1. **Open** — complaint is logged, unique ID assigned, originator notified.
2. **Acknowledged** — responsible party has seen and accepted the complaint.
3. **Under Investigation** — root cause analysis or evidence gathering in progress.
4. **Containment Applied** — _(optional)_ interim fix in place, work can proceed.
5. **Resolution In Progress** — corrective action being implemented.
6. **Resolved** — fix applied, re-entering process chain for re-verification.
7. **Awaiting Validation** — originator reviews the resolution.
8. **Closed** — originator approved; complaint is done.
9. **Reopened** — originator rejected the resolution; cycles back to Investigation or Resolution.

Not all complaints will pass through every state. A missing-photo complaint may go directly Open → Resolved → Awaiting Validation → Closed. The state machine should allow skipping optional states.

### 4.2 Key Transitions to Validate During Discovery

- **Open → Acknowledged:** Is this automatic (system assignment) or manual (someone claims the complaint)?
- **Containment Applied → Resolution In Progress:** Can containment exist without a follow-up corrective action, or is it always a precursor?
- **Resolved → Awaiting Validation:** Does the process chain re-verification happen _before_ or _after_ originator validation?
- **Awaiting Validation → Closed vs. Reopened:** What is the rejection rate? How many re-open cycles are typical?
- **Reopened → ?:** Does it go back to Investigation (root cause was wrong) or directly to Resolution (fix was incomplete)?

### 4.3 Domain Events

Events emitted by the Complaint Management BC for consumption by other bounded contexts:

|Event|Consumers / Effect|
|---|---|
|`ComplaintRaised`|Triggers notifications; may affect project status|
|`ComplaintAcknowledged`|SLA clock starts|
|`ContainmentApplied`|May unblock dependent process steps|
|`ResolutionSubmitted`|Triggers re-entry into the process chain|
|`ProcessChainReEntryTriggered`|Signals other contexts to re-verify affected steps|
|`ValidationRequested`|Notifies originator|
|`ValidationApproved`|Closes the complaint; updates project status; feeds reporting|
|`ValidationRejected`|Reopens the complaint; resets SLA for next resolution cycle|
|`ComplaintClosed`|Final event; aggregated for analytics and trend reporting|

---

## 5. Error Taxonomy Design

### 5.1 Design Principles

- **Hierarchical structure:** Category → Subcategory → Specific Error Type. This allows both high-level reporting and detailed drill-down.
- **MECE (Mutually Exclusive, Collectively Exhaustive):** Every defect should fit exactly one category. Minimize the need for "Other."
- **Field-validated:** Ask KPS 4, KPS 1, and Output Control to categorize real past defects using the proposed taxonomy. If they struggle, the taxonomy needs refinement.
- **Shared vs. separate:** Determine during discovery whether construction-phase and post-commerce complaints share the same error types or need distinct branches.
- **Symptom + Root Cause:** Track both _what went wrong_ (symptom / error type) and _why it happened_ (root cause). Even if root cause tracking is deferred to a future phase, design the data model so it can be added without restructuring.

### 5.2 Candidate Top-Level Categories

Starting point — validate and refine with stakeholders:

|Category|Example Defects|
|---|---|
|Documentation Defects|Missing photos, incomplete forms, wrong metadata|
|Construction Quality|Bad fiber split, incorrect cable routing, physical damage|
|Network Configuration|Incorrect network inventory data, wrong port assignment|
|Process / Handover|Missed handover step, incomplete checklist, wrong status|
|Material / Equipment|Defective components, wrong specification used|
|Safety / Compliance|Safety standard violation, regulatory non-compliance|

### 5.3 Anti-Patterns to Avoid

These are the most common mistakes in error taxonomy design. Watch for them actively:

**The "Other" trap.** If more than 15–20% of complaints end up categorized as "Other," the taxonomy is insufficient. This is the single most common failure mode. During validation with field users, track how often they reach for "Other" — that's your canary in the coal mine.

**Too granular too early.** Resist the urge to create a 50-item codelist from day one. Start with 5–8 top-level categories, deploy, and let real data guide subcategory creation. A taxonomy that's too detailed discourages correct classification — people will pick the first thing that's "close enough."

**Symptom-only classification.** Tracking _what_ went wrong (missing photo, bad splice) is necessary but insufficient. Without tracking _why_ it happened (training gap, unclear specification, supplier quality, time pressure), you can't drive systemic improvement. Even if root cause is a future-phase feature, reserve a field for it in the data model now.

**Unstable categories.** If categories keep being renamed, merged, or split after launch, historical reporting breaks. Invest time upfront to get the top-level categories stable. Subcategories can evolve more freely.

**Role-biased taxonomy.** Different roles see different defects. If you build the taxonomy based on interviews with only one role (e.g., Output Control), it will be blind to defect types that other roles encounter. Cross-validate across the full process chain.

**No governance for taxonomy changes.** Someone needs to own the codelist. Without a clear process for proposing, reviewing, and approving changes to the taxonomy, it will either fossilize (becoming irrelevant) or mutate chaotically (breaking reporting). Define who owns it and how changes are approved as part of the MVP.

**Confusing severity with error type.** "Critical defect" is not an error type — it's a severity level applied _to_ an error type. Keep the two dimensions separate. A missing photo might be Minor in one context and Critical in another (e.g., if it blocks commercialization).

---

## 6. Analysis Checklist

Use this checklist to track progress during the 2-week analysis phase. Each item should be addressed before proceeding to development.

### 6.1 Process Understanding

- [ ] Map current complaint handling for each role (interviews with all key contacts)
- [ ] Document current communication channels used (email, phone, notes, verbal?)
- [ ] Identify existing data / records / spreadsheets (shadow systems, personal trackers)
- [ ] Map the full process chain with re-entry points (which steps are affected by which defects?)
- [ ] Document pain points and workarounds (what breaks, what frustrates?)
- [ ] Fill in the two-complaint-type comparison matrix (Section 2.4)
- [ ] Determine if error taxonomy is shared or separate for construction vs. post-commerce
- [ ] Identify shared vs. divergent workflow steps between the two complaint types

### 6.2 Lifecycle & Rules

- [ ] Define complaint states and allowed transitions (state machine diagram — see Section 4)
- [ ] Define which states are optional / skippable (e.g., Containment)
- [ ] Define re-open conditions and limits (max re-opens? escalation after N cycles?)
- [ ] Clarify validation gate: blocking vs. advisory
- [ ] Define timeout / escalation if originator is unavailable
- [ ] Determine if delegate validation is allowed
- [ ] Define target resolution times by severity (Critical, Major, Minor)
- [ ] Define escalation rules when SLA is breached (who gets notified? auto-escalate?)
- [ ] Map who can raise, assign, resolve, validate, close (role-based access matrix)
- [ ] Determine visibility rules (who can see which complaints?)

### 6.3 Data & Taxonomy

- [ ] Draft error type codelist — top-level categories (5–8 categories)
- [ ] Validate taxonomy with field users using real past defects (KPS 4, KPS 1, Output Control)
- [ ] Check "Other" usage rate on draft taxonomy (target: < 15–20%)
- [ ] Decide on root cause tracking — now or future phase? (separate from symptom?)
- [ ] Define mandatory vs. optional fields on complaint form (what is required at creation?)
- [ ] Define attachment requirements — photos, docs (file types, size limits, mandatory?)
- [ ] Determine audit trail requirements (what must be logged? every state change?)
- [ ] Define the subject reference model (Project, Work Order, Network Element — or combination?)

### 6.4 Integration & Architecture

- [ ] Confirm Complaint Management as a separate bounded context (not a sub-module of Project)
- [ ] Define aggregate root and entity boundaries
- [ ] Define domain events and their consumers (which BCs react to which events?)
- [ ] Map integration with Project Context (status impact, references)
- [ ] Map integration with Process Management (re-entry trigger mechanism)
- [ ] Map integration with Network Inventory (which NE data is referenced?)
- [ ] Discuss technical constraints with IS/Gába (API patterns, data storage, events)
- [ ] Determine notification mechanism (email, in-app, Teams?)

### 6.5 Reporting & Analytics

- [ ] Define operational dashboard requirements (open complaints by status/severity/age, SLA compliance)
- [ ] Define quality/trend analysis requirements (most frequent errors, trends over time, per contractor)
- [ ] Identify who consumes which reports (roles → dashboards mapping)
- [ ] Define which reports are MVP vs. future phase

### 6.6 MVP Scoping

- [ ] Define MVP feature set — must-have vs. nice-to-have (MoSCoW or similar)
- [ ] Decide: both complaint types in MVP or phased? (construction first, then post-commerce?)
- [ ] Define MVP error taxonomy — minimal viable codelist (can be extended later)
- [ ] Identify technical dependencies / blockers (what must exist before dev starts?)
- [ ] Estimate effort with IS/dev team based on analysis output
- [ ] Get stakeholder sign-off on analysis output before development begins

---

## 7. Recommended Next Steps

1. **Week 1:** Conduct stakeholder interviews using the framework in Section 2. Fill in the comparison matrix (Section 2.4) and draft the error taxonomy (Section 2.5).
2. **Week 1:** Map the as-is process, including the re-entry logic, with Martin Dvořák and Petr Nedvěd.
3. **Week 2:** Validate the draft domain model and error taxonomy with field users.
4. **Week 2:** Discuss technical constraints and integration approach with IS/Gába.
5. **Week 2:** Define MVP scope and get stakeholder alignment.
6. **End of Week 2:** Deliver analysis output document (refined version of this guide with all sections filled in) for sign-off before development begins.