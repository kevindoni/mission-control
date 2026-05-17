# Agent Skill Creation Loop — Spec

## Problem

Autensa agents start every dispatch with zero task-specific memory beyond what the knowledge base provides. If a builder agent figures out that LeadsFire needs `--legacy-peer-deps` for npm ci, or that the GFH deploy script must run as www-data, that knowledge either gets captured as a generic text blob in `knowledge_entries` (143 entries, mostly low-signal pattern/baseline noise) or it's lost entirely when the session dies.

The existing learner module captures *what happened* (stage transitions, pass/fail) but not *how to do things* — reusable, executable procedures that agents can follow.

## What We're Building

A closed-loop skill system where agents autonomously create, improve, and consume structured skills scoped to each product. Not generic knowledge entries — **executable playbooks** that compound over time.

### How It's Different from Current Knowledge Base

| Current `knowledge_entries` | New `product_skills` |
|---|---|
| Text blobs about what happened | Structured steps with prerequisites, commands, verification |
| Triggered on stage transitions | Triggered on task completion (success or instructive failure) |
| Injected as "lessons learned" footnote | Matched by skill type and injected as primary instructions |
| 143 entries, mostly noise | Curated by confidence scoring + usage tracking |
| No feedback loop | Skills improve when agents report deviations |

## Schema

### New Table: `product_skills`

```sql
CREATE TABLE product_skills (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  skill_type TEXT NOT NULL,        -- 'build', 'deploy', 'test', 'fix', 'config', 'pattern'
  title TEXT NOT NULL,
  trigger_pattern TEXT,             -- regex/keyword that matches task descriptions
  prerequisites TEXT,               -- JSON: things that must be true before using this skill
  steps TEXT NOT NULL,              -- JSON array of step objects
  verification TEXT,                -- JSON: how to confirm the skill worked
  confidence REAL DEFAULT 0.5,      -- 0.0-1.0, increases with successful use
  times_used INTEGER DEFAULT 0,
  times_succeeded INTEGER DEFAULT 0,
  last_used_at TEXT,
  created_by_task_id TEXT,
  created_by_agent_id TEXT,
  supersedes_skill_id TEXT,         -- points to older version this replaced
  status TEXT DEFAULT 'active',     -- 'active', 'deprecated', 'draft'
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE INDEX idx_product_skills_product ON product_skills(product_id, skill_type, status);
CREATE INDEX idx_product_skills_confidence ON product_skills(confidence DESC);
```

### Step Object Shape

```typescript
interface SkillStep {
  order: number;
  description: string;
  command?: string;        // shell command if applicable
  code?: string;           // code snippet if applicable
  file_path?: string;      // relevant file
  expected_output?: string; // what success looks like
  fallback?: string;       // what to do if this step fails
  notes?: string;          // context from the agent that created it
}
```

## The Loop (4 phases)

### Phase 1: Capture (post-task)

When a task completes with status `done`:

1. MC sends a **skill extraction prompt** to the agent's session before it's killed
2. Prompt: "Before this session ends, extract any reusable procedures you discovered. For each, provide: title, type, trigger pattern, prerequisite conditions, numbered steps with commands, and verification method. POST to `/api/products/{id}/skills` with the structured JSON."
3. Agent has 60 seconds to respond before session cleanup
4. New skills created with `confidence: 0.5` (unproven) and `status: 'draft'`

When a task fails and the failure teaches something:

1. Same extraction prompt but focused on "what procedure would have prevented this failure?"
2. Skills from failures start at `confidence: 0.4` (lower, needs validation)

### Phase 2: Match (pre-dispatch)

During dispatch (in `dispatch/route.ts`), before building the agent message:

1. Query `product_skills` for the task's product where `status = 'active'` and `confidence >= 0.6`
2. Match skills by:
   - `skill_type` matching the agent's role (builder → 'build'/'config'/'pattern', tester → 'test')
   - `trigger_pattern` regex against task title + description
   - Fallback: top 3 by confidence for the product
3. Format matched skills as structured instructions (not footnotes — primary guidance)
4. Inject BEFORE the planning spec in the dispatch message

### Phase 3: Report (during task)

Add a new API endpoint the agent calls during execution:

```
POST /api/products/{productId}/skills/{skillId}/report
{
  "task_id": "...",
  "used": true,           // did the agent actually use this skill?
  "succeeded": true,      // did following it lead to success?
  "deviation": "...",     // if the agent had to modify the steps, what changed?
  "suggested_update": {}  // optional: improved version of the skill
}
```

On report:
- `times_used++`
- If succeeded: `times_succeeded++`, recalculate `confidence = times_succeeded / times_used`
- If deviation reported: flag for review or auto-update if confidence is high enough

### Phase 4: Improve (periodic)

Cron job (nightly or weekly):

1. Promote `draft` skills to `active` if `times_succeeded >= 2` and `confidence >= 0.6`
2. Deprecate skills with `confidence < 0.3` and `times_used >= 3` (tried multiple times, keeps failing)
3. When a `suggested_update` exists with higher confidence than the original, create new version with `supersedes_skill_id` pointing to old one, deprecate old
4. Merge duplicate skills (same product, similar trigger_pattern, overlapping steps)

## Integration Points

### dispatch/route.ts (modify)
```typescript
// After knowledge section, before planning spec
const skills = getMatchedSkills(task.product_id, task.title, task.description, agent.name);
const skillsSection = formatSkillsForDispatch(skills);
// ... inject into message
```

### New: skill-extraction.ts
```typescript
// Called from task-lifecycle when status → done
export async function requestSkillExtraction(taskId: string, sessionKey: string): Promise<void>
```

### New API Routes
- `POST /api/products/[id]/skills` — agent creates a skill
- `GET /api/products/[id]/skills` — list skills for product
- `PATCH /api/products/[id]/skills/[skillId]` — update skill
- `POST /api/products/[id]/skills/[skillId]/report` — agent reports usage

### UI (TaskModal or Product Dashboard)
- Skills tab showing product's skill library
- Confidence bars, usage counts, created-by-task links
- Manual approve/deprecate/edit controls

## What This Unlocks

1. **Agent #1** builds LeadsFire, discovers npm needs `--legacy-peer-deps` → creates "LeadsFire Build" skill
2. **Agent #2** gets dispatched for LeadsFire feature → receives the skill as primary instructions → succeeds first try → confidence bumps to 0.67
3. **Agent #3** same product → skill at 0.75 confidence, injected automatically → agent reports it worked with one deviation (new env var needed) → skill auto-updates
4. After 5 successful uses, the skill is at 0.9+ confidence and effectively becomes the product's build playbook

## Build Order

1. Migration: `product_skills` table + indexes
2. `src/lib/skills.ts` — CRUD helpers, matching logic, formatting
3. `src/app/api/products/[id]/skills/` routes (create, list, update, report)
4. `src/lib/skill-extraction.ts` — post-task extraction prompt
5. Modify `dispatch/route.ts` — inject matched skills
6. Modify task completion flow — trigger extraction before session cleanup
7. UI: Skills tab in product dashboard
8. Cron: nightly skill promotion/deprecation

## Estimated Scope

~800-1000 lines new code. 1 migration. 4 API routes. 1 new lib module. Modifications to dispatch and task-lifecycle. UI component.

No breaking changes to existing flows — skills injection is additive to the dispatch message, and extraction is best-effort (failure doesn't block task completion).
