# Settings Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove per-camera MQTT topic fields from the Add Camera dialog (defaults come from new global settings templates instead), and relocate the Detection Mode control from the Line Configuration tab to Basic Settings as a dropdown.

**Architecture:** Two independent, small UI/API changes in the dashboard only — no python-counting changes, no DB changes. Topic template substitution happens once, at device-creation time, in the `POST /api/devices` handler.

**Tech Stack:** Next.js 16 App Router, TypeScript, existing shadcn `Select`/`Input`/`Switch` components.

**Spec:** `docs/superpowers/specs/2026-07-03-multi-detection-apd-fire-smoke-design.md` (Part A)

---

### Task 1: Add MQTT topic templates to global settings

**Files:**
- Modify: `dashboard/lib/types.ts:99-104` (mqtt block in `GlobalSettings`)
- Modify: `dashboard/lib/types.ts:130-135` (mqtt block in `DEFAULT_SETTINGS`)

- [ ] **Step 1: Add the two template fields to the `GlobalSettings` interface**

In `dashboard/lib/types.ts`, replace:
```typescript
  mqtt: {
    broker: string;
    port: string;
    username: string;
    password: string;
  };
```
with:
```typescript
  mqtt: {
    broker: string;
    port: string;
    username: string;
    password: string;
    activityTopicTemplate: string;   // '{code}' is replaced with the device code at creation time
    intervalTopicTemplate: string;
  };
```

- [ ] **Step 2: Add matching defaults**

In the same file, replace:
```typescript
  mqtt: {
    broker: '',
    port: '1883',
    username: '',
    password: '',
  },
```
with:
```typescript
  mqtt: {
    broker: '',
    port: '1883',
    username: '',
    password: '',
    activityTopicTemplate: '/person_in/{code}',
    intervalTopicTemplate: '/resampling_person/{code}',
  },
```

- [ ] **Step 3: Verify `readSettings()` needs no change**

Open `dashboard/lib/settings.ts` and confirm the `mqtt` merge line reads:
```typescript
      mqtt: { ...DEFAULT_SETTINGS.mqtt, ...parsed.mqtt },
```
This already spreads `DEFAULT_SETTINGS.mqtt` first, so the two new keys are present with their defaults even for settings.json files written before this change. No edit needed here — this step is a verification, not a code change.

- [ ] **Step 4: Typecheck**

Run: `cd dashboard && ./node_modules/.bin/tsc --noEmit`
Expected: no errors (any error means a `GlobalSettings.mqtt` consumer elsewhere needs updating — search with `grep -rn "settings.mqtt" dashboard/app dashboard/lib` and fix any exhaustive object literal that doesn't spread from `DEFAULT_SETTINGS`).

- [ ] **Step 5: Commit**

```bash
git add dashboard/lib/types.ts
git commit -m "Add MQTT topic template fields to global settings"
```

---

### Task 2: Show topic templates in the Settings page

**Files:**
- Modify: `dashboard/app/settings/page.tsx:147-162` (MQTT Broker section)

- [ ] **Step 1: Add two input fields for the templates**

Replace the MQTT Broker `<Section>` block:
```tsx
      <Section title="MQTT Broker">
        <div className="grid grid-cols-2 gap-4">
          <FormField label="Broker Host">
            <Input value={settings.mqtt.broker} onChange={e => setMqtt('broker', e.target.value)} placeholder="10.11.0.34" />
          </FormField>
          <FormField label="Port">
            <Input type="number" value={settings.mqtt.port} onChange={e => setMqtt('port', e.target.value)} placeholder="1883" />
          </FormField>
          <FormField label="Username">
            <Input value={settings.mqtt.username} onChange={e => setMqtt('username', e.target.value)} />
          </FormField>
          <FormField label="Password">
            <Input type="password" value={settings.mqtt.password} onChange={e => setMqtt('password', e.target.value)} />
          </FormField>
        </div>
      </Section>
```
with:
```tsx
      <Section title="MQTT Broker">
        <div className="grid grid-cols-2 gap-4">
          <FormField label="Broker Host">
            <Input value={settings.mqtt.broker} onChange={e => setMqtt('broker', e.target.value)} placeholder="10.11.0.34" />
          </FormField>
          <FormField label="Port">
            <Input type="number" value={settings.mqtt.port} onChange={e => setMqtt('port', e.target.value)} placeholder="1883" />
          </FormField>
          <FormField label="Username">
            <Input value={settings.mqtt.username} onChange={e => setMqtt('username', e.target.value)} />
          </FormField>
          <FormField label="Password">
            <Input type="password" value={settings.mqtt.password} onChange={e => setMqtt('password', e.target.value)} />
          </FormField>
          <FormField label="Default Activity Topic Template">
            <Input
              value={settings.mqtt.activityTopicTemplate}
              onChange={e => setMqtt('activityTopicTemplate', e.target.value)}
              placeholder="/person_in/{code}"
            />
          </FormField>
          <FormField label="Default Interval Topic Template">
            <Input
              value={settings.mqtt.intervalTopicTemplate}
              onChange={e => setMqtt('intervalTopicTemplate', e.target.value)}
              placeholder="/resampling_person/{code}"
            />
          </FormField>
        </div>
        <p className="text-xs text-muted-foreground">
          <code className="font-mono bg-muted px-1 rounded">{'{code}'}</code> is replaced with the device code when a new camera is created. Existing cameras are not affected — edit their topics individually on the device page.
        </p>
      </Section>
```

- [ ] **Step 2: Typecheck**

Run: `cd dashboard && ./node_modules/.bin/tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add dashboard/app/settings/page.tsx
git commit -m "Show MQTT topic templates on the Settings page"
```

---

### Task 3: Remove topic fields from the Add Camera dialog

**Files:**
- Modify: `dashboard/app/devices/page.tsx:196-202` (form state)
- Modify: `dashboard/app/devices/page.tsx:227` (form reset after submit)
- Modify: `dashboard/app/devices/page.tsx:267-280` (remove the two Field blocks)

- [ ] **Step 1: Remove topic fields from form state**

Replace:
```tsx
  const [form, setForm] = useState({
    deviceName: '',
    deviceCode: '',
    activityTopic: '/person_in',
    intervalTopic: '',
    rtspUrl: '',
  });
```
with:
```tsx
  const [form, setForm] = useState({
    deviceName: '',
    deviceCode: '',
    rtspUrl: '',
  });
```

- [ ] **Step 2: Update the post-submit form reset**

Replace:
```tsx
      setForm({ deviceName: '', deviceCode: '', activityTopic: '/person_in', intervalTopic: '', rtspUrl: '' });
```
with:
```tsx
      setForm({ deviceName: '', deviceCode: '', rtspUrl: '' });
```

- [ ] **Step 3: Remove the Activity Topic and Interval Topic form fields**

Delete these two `<Field>` blocks entirely (they sit between the RTSP URL field and the Cancel/Create button row):
```tsx
          <Field label="Activity Topic">
            <Input
              value={form.activityTopic}
              onChange={e => handleChange('activityTopic', e.target.value)}
              placeholder="/person_in"
            />
          </Field>
          <Field label="Interval Topic">
            <Input
              value={form.intervalTopic}
              onChange={e => handleChange('intervalTopic', e.target.value)}
              placeholder="/resampling_person/EPW/CCTV_EPW_B2S"
            />
          </Field>
```
After deletion, the form should go directly from the "Stream URL (RTSP)" `<Field>` to the `<div className="flex gap-2 pt-2 justify-end">` button row.

- [ ] **Step 4: Typecheck**

Run: `cd dashboard && ./node_modules/.bin/tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add dashboard/app/devices/page.tsx
git commit -m "Remove per-camera MQTT topic fields from the Add Camera dialog"
```

---

### Task 4: Derive topics from settings templates on device creation

**Files:**
- Modify: `dashboard/app/api/devices/route.ts:58-59` (destructure body)
- Modify: `dashboard/app/api/devices/route.ts:89-90` (MQTT_TOPIC / MQTT_INTERVAL_TOPIC values)

- [ ] **Step 1: Stop reading topic fields from the request body**

Replace:
```typescript
    const { deviceCode, deviceName, activityTopic, intervalTopic, rtspUrl } = body;
```
with:
```typescript
    const { deviceCode, deviceName, rtspUrl } = body;
```

- [ ] **Step 2: Derive topics from the global settings templates**

Replace:
```typescript
      MQTT_TOPIC: activityTopic || '/person_in',
      MQTT_INTERVAL_TOPIC: intervalTopic || '',
```
with:
```typescript
      MQTT_TOPIC: settings.mqtt.activityTopicTemplate.replace(/\{code\}/g, deviceCode),
      MQTT_INTERVAL_TOPIC: settings.mqtt.intervalTopicTemplate.replace(/\{code\}/g, deviceCode),
```

- [ ] **Step 3: Typecheck**

Run: `cd dashboard && ./node_modules/.bin/tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add dashboard/app/api/devices/route.ts
git commit -m "Derive new-camera MQTT topics from global settings templates"
```

---

### Task 5: Relocate Detection Mode to Basic Settings as a dropdown

**Files:**
- Modify: `dashboard/app/devices/[code]/page.tsx:340-341` (insert new Section)
- Modify: `dashboard/app/devices/[code]/page.tsx:391-413` (remove old Section, keep everything after it)

- [ ] **Step 1: Insert a Detection Mode dropdown into Basic Settings**

Replace:
```tsx
              <FormField label="Frame Skip">
                <Input type="number" value={env.FRAME_SKIP || '2'} onChange={e => setField('FRAME_SKIP', e.target.value)} />
              </FormField>
            </div>
          </Section>

          <Section title="Detection Model (Triton)">
```
with:
```tsx
              <FormField label="Frame Skip">
                <Input type="number" value={env.FRAME_SKIP || '2'} onChange={e => setField('FRAME_SKIP', e.target.value)} />
              </FormField>
            </div>
          </Section>

          <Section title="Detection Mode">
            <FormField label="Mode">
              <Select value={env.DETECTION_MODE || 'line_crossing'} onValueChange={v => v && setField('DETECTION_MODE', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="line_crossing">Line Crossing</SelectItem>
                  <SelectItem value="zone">Zone Detection</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1.5">
                Modes are exclusive. Switching mode clears the other mode&apos;s configuration on save.
              </p>
            </FormField>
          </Section>

          <Section title="Detection Model (Triton)">
```
(This is the only `<FormField label="Frame Skip">` in the file, so the match is unambiguous.)

- [ ] **Step 2: Remove the old button-group Detection Mode section from the Line Configuration tab**

In the `lines` `TabsContent`, delete this entire block (it is the first thing inside that tab, right after `<TabsContent value="lines" className="space-y-6 pt-4">`):
```tsx
          <Section title="Detection Mode">
            <div className="flex gap-3">
              {(['line_crossing', 'zone'] as const).map(m => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setField('DETECTION_MODE', m)}
                  className={`px-4 py-2 rounded-md text-sm border transition-colors ${
                    (env.DETECTION_MODE || 'line_crossing') === m
                      ? 'border-primary bg-primary/10 text-primary font-medium'
                      : 'border-border text-muted-foreground hover:bg-accent'
                  }`}
                >
                  {m === 'line_crossing' ? 'Line Crossing' : 'Zone Detection'}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground mt-1.5">
              Modes are exclusive. Switching mode clears the other mode&apos;s configuration on save.
            </p>
          </Section>

```
Do **not** remove the code right after it (`{(env.DETECTION_MODE || 'line_crossing') === 'line_crossing' ? ( ... ) : ( ... )}`) — that conditional still reads `env.DETECTION_MODE` and continues to gate the line/zone drawing UI exactly as before. After this edit, `lines` `TabsContent` should start directly with that conditional.

- [ ] **Step 3: Typecheck**

Run: `cd dashboard && ./node_modules/.bin/tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add "dashboard/app/devices/[code]/page.tsx"
git commit -m "Move Detection Mode control from Line Configuration to Basic Settings"
```

---

### Task 6: Manual verification

- [ ] **Step 1: Build the dashboard**

Run: `cd dashboard && npm run build`
Expected: build succeeds with no type errors, all routes listed in the output (same route list as before — this change touches no routes, only page content).

- [ ] **Step 2: Start the dev server and walk through the flow**

Run: `cd dashboard && npm run dev`, open `http://localhost:3000/settings`.
Verify:
- "Default Activity Topic Template" and "Default Interval Topic Template" fields are visible under MQTT Broker, with the `{code}` placeholder text visible below them.
- Change a template value, click Save Settings, reload the page — the new value persists.

- [ ] **Step 3: Create a camera and confirm topics are derived**

On `/devices`, click "Add Camera". Confirm the dialog no longer shows Activity Topic / Interval Topic fields (only Device Name, Device Code, Stream URL). Create a camera with code `TESTCAM`.
Open `/devices/TESTCAM` → Basic Settings → MQTT Topics section, and confirm `MQTT_TOPIC` reads `/person_in/TESTCAM` (or whatever template was configured) and `MQTT_INTERVAL_TOPIC` reads `/resampling_person/TESTCAM`.

- [ ] **Step 4: Confirm Detection Mode moved correctly**

On `/devices/TESTCAM`, open Basic Settings — confirm a "Detection Mode" dropdown appears (Line Crossing / Zone Detection). Switch to Line Configuration tab — confirm the old button-group control is gone, and the line/zone drawing UI still renders correctly based on the mode selected in Basic Settings.

- [ ] **Step 5: Clean up the test camera**

On `/devices`, delete `TESTCAM`.

- [ ] **Step 6: Final commit (if any fixups were needed)**

```bash
git add -A
git commit -m "Fix issues found during Settings Simplification manual verification"
```
(Only run this if Step 1-5 required code changes; otherwise there is nothing to commit here.)
