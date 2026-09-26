<script lang="ts">
  import {
    clips,
    confirmMerge,
    currentProjectName,
    frames,
    loadLocalSource,
    parseFileSource,
    preflight,
    projects,
    currentProjectId
  } from "../core/store";
  import {
    applyMergePlan,
    buildMergePlan,
    buildMergePreview,
    type ConflictPolicy,
    type MergePreview,
    type MergeProjectData,
    type ResolutionOverride
  } from "../core/merge";
  import type { MergeSource } from "../core/mergeExec";

  export let onClose: () => void;

  type SourceKind = "local" | "file";
  let sourceKind: SourceKind = "local";
  let selectedSourceId = "";
  let jsonFile: File | null = null;
  let atlasFile: File | null = null;

  let source: MergeSource | null = null;
  let preview: MergePreview | null = null;
  let errors: string[] = [];
  let generating = false;

  let policy: ConflictPolicy = "rename";
  let overrides: Record<string, ResolutionOverride> = {};

  let confirming = false;
  let confirmError = "";

  $: otherProjects = $projects.filter((p) => p.id !== $currentProjectId);
  $: currentData = toProjectData($currentProjectName, $frames, $clips);

  function toProjectData(
    name: string,
    fs: typeof $frames,
    cs: typeof $clips
  ): MergeProjectData {
    return {
      name,
      frames: fs.map((f) => ({ id: f.id, name: f.name, hash: f.hash, duration: f.duration, width: f.width, height: f.height })),
      clips: cs.map((c) => ({ ...c, frameIds: [...c.frameIds] }))
    };
  }

  function onJsonPicked(e: Event) {
    const files = [...((e.currentTarget as HTMLInputElement).files ?? [])];
    jsonFile = files.find((f) => f.name.toLowerCase().endsWith(".json")) ?? null;
    atlasFile = files.find((f) => f.name.toLowerCase().endsWith(".png")) ?? null;
  }

  async function generate() {
    errors = [];
    preview = null;
    source = null;
    confirmError = "";
    generating = true;
    try {
      if (sourceKind === "local") {
        if (!selectedSourceId) {
          errors = ["请选择要合并的本地工程"];
          return;
        }
        source = await loadLocalSource(selectedSourceId);
      } else {
        if (!jsonFile) {
          errors = ["请选择导出的 JSON 文件"];
          return;
        }
        source = await parseFileSource(jsonFile, atlasFile ?? undefined);
      }
      errors = await preflight(source);
      preview = buildMergePreview(currentData, source.data);
      overrides = {};
    } catch (e) {
      errors = [e instanceof Error ? e.message : String(e)];
    } finally {
      generating = false;
    }
  }

  /** 批量规则：设置策略并清空单项覆盖 */
  function applyBatch(p: ConflictPolicy) {
    policy = p;
    overrides = {};
  }

  function setAction(name: string, action: ConflictPolicy) {
    overrides = { ...overrides, [name]: { ...overrides[name], action } };
  }
  function setNewName(name: string, newName: string) {
    overrides = { ...overrides, [name]: { ...overrides[name], action: "rename", newName } };
  }
  function effectiveAction(name: string): ConflictPolicy {
    return overrides[name]?.action ?? policy;
  }

  // 预览随策略/覆盖实时重算（纯函数，开销可忽略）
  $: analysis = (() => {
    if (!source || !preview) return null;
    const plan = buildMergePlan(currentData, source.data, policy, overrides);
    if (plan.errors.length > 0) return { plan, applied: null };
    try {
      return { plan, applied: applyMergePlan(currentData, source.data, plan) };
    } catch {
      return { plan, applied: null };
    }
  })();

  /** 冲突帧的最终名称（重命名时展示） */
  function finalNameOf(importedFrameId: string, fallback: string): string {
    const a = analysis?.plan.actions.get(importedFrameId);
    return a && a.type === "add" ? a.newName : fallback;
  }

  const EFFECT_LABEL: Record<string, string> = {
    dedup: "去重，指向现有帧",
    "drop-to-current": "保留当前，改指当前帧",
    replace: "采用导入，内容被替换",
    add: "新增帧",
    rename: "重命名为新帧"
  };

  async function confirm() {
    if (!source) return;
    confirming = true;
    confirmError = "";
    try {
      await confirmMerge(source, policy, overrides);
      onClose();
    } catch (e) {
      confirmError = e instanceof Error ? e.message : String(e);
    } finally {
      confirming = false;
    }
  }

  $: canConfirm =
    !!source && !!preview && errors.length === 0 && !generating && !confirming &&
    (analysis?.plan.errors.length ?? 0) === 0;
</script>

<div class="overlay" role="dialog" aria-label="合并工程">
  <div class="dialog" id="merge-dialog">
    <div class="head">
      <h2>合并工程到「{$currentProjectName}」</h2>
      <button class="close" on:click={onClose} aria-label="关闭">✕</button>
    </div>

    <!-- 1. 选择导入工程 -->
    <section>
      <h3>1. 选择导入工程</h3>
      <div class="row">
        <label><input type="radio" bind:group={sourceKind} value="local" /> 本地工程</label>
        <label><input type="radio" bind:group={sourceKind} value="file" /> JSON 文件</label>
      </div>
      {#if sourceKind === "local"}
        <div class="row">
          <select id="merge-source-select" bind:value={selectedSourceId}>
            <option value="" disabled>选择工程…</option>
            {#each otherProjects as p (p.id)}
              <option value={p.id}>{p.name}（{p.frameCount} 帧 / {p.clipCount} 片段）</option>
            {/each}
          </select>
          {#if otherProjects.length === 0}
            <span class="dim">没有其他本地工程，可改用 JSON 文件，或先「导入 JSON」创建。</span>
          {/if}
        </div>
      {:else}
        <div class="row">
          <input id="merge-file-input" type="file" accept=".json,application/json,image/png" multiple on:change={onJsonPicked} />
          {#if jsonFile}<span class="mono dim">{jsonFile.name}{atlasFile ? ` + ${atlasFile.name}` : ""}</span>{/if}
        </div>
      {/if}
      <div class="row">
        <button class="primary" id="merge-preview-btn" disabled={generating} on:click={() => void generate()}>
          {generating ? "校验中…" : "生成合并预览"}
        </button>
      </div>
    </section>

    {#if errors.length > 0}
      <section class="errors" id="merge-errors">
        <h3>发现问题（无法合并）</h3>
        <ul>
          {#each errors as err}
            <li>{err}</li>
          {/each}
        </ul>
      </section>
    {/if}

    {#if preview && source}
      <!-- 2. 预览 -->
      <section id="merge-preview">
        <h3>2. 合并预览（来源：{source.name} · {source.data.frames.length} 帧 / {source.data.clips.length} 片段）</h3>

        <div class="group" id="preview-identical">
          <h4>相同帧（同名同内容，自动去重）<span class="count">{preview.identical.length}</span></h4>
          {#if preview.identical.length === 0}
            <div class="dim">无</div>
          {:else}
            <ul>
              {#each preview.identical as e (e.importedFrameId)}
                <li>
                  <span class="mono">{e.name}</span> — 只保留当前一份
                  {#if e.importedReferencedBy.length > 0}
                    ，导入方片段 [{e.importedReferencedBy.join("、")}] 的引用将合并到现有帧
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </div>

        <div class="group" id="preview-conflicts">
          <h4>同名冲突（内容不同，需决策）<span class="count">{preview.conflicts.length}</span></h4>
          {#if preview.conflicts.length > 0}
            <div class="row batch">
              批量规则：
              <button class:active={policy === "keep-current"} on:click={() => applyBatch("keep-current")}>全部保留当前</button>
              <button class:active={policy === "use-imported"} on:click={() => applyBatch("use-imported")}>全部采用导入</button>
              <button class:active={policy === "rename"} on:click={() => applyBatch("rename")}>全部重命名导入项</button>
              <span class="dim">应用后仍可逐项覆盖</span>
            </div>
            <ul class="conflicts" id="conflict-list">
              {#each preview.conflicts as c (c.importedFrameId)}
                <li class="conflict" data-conflict-name={c.name}>
                  <div class="cname mono">{c.name}</div>
                  <div class="opts">
                    <label>
                      <input
                        type="radio"
                        checked={effectiveAction(c.name) === "keep-current"}
                        on:change={() => setAction(c.name, "keep-current")}
                      />
                      保留当前
                    </label>
                    <label>
                      <input
                        type="radio"
                        checked={effectiveAction(c.name) === "use-imported"}
                        on:change={() => setAction(c.name, "use-imported")}
                      />
                      采用导入
                    </label>
                    <label>
                      <input
                        type="radio"
                        checked={effectiveAction(c.name) === "rename"}
                        on:change={() => setAction(c.name, "rename")}
                      />
                      重命名导入项
                    </label>
                    {#if effectiveAction(c.name) === "rename"}
                      <input
                        type="text"
                        class="rename-input"
                        placeholder={finalNameOf(c.importedFrameId, c.name)}
                        value={overrides[c.name]?.newName ?? ""}
                        on:input={(e) => setNewName(c.name, e.currentTarget.value)}
                      />
                      <span class="mono dim">→ {finalNameOf(c.importedFrameId, c.name)}</span>
                    {/if}
                  </div>
                  <div class="dim refs">
                    {#if c.currentReferencedBy.length > 0}当前片段 [{c.currentReferencedBy.join("、")}] 引用了它；{/if}
                    {#if c.importedReferencedBy.length > 0}导入片段 [{c.importedReferencedBy.join("、")}] 引用了它{/if}
                  </div>
                </li>
              {/each}
            </ul>
          {:else}
            <div class="dim">无</div>
          {/if}
        </div>

        <div class="group" id="preview-additions">
          <h4>新增帧（追加到帧列表末尾）<span class="count">{preview.additions.length}</span></h4>
          {#if preview.additions.length === 0}
            <div class="dim">无</div>
          {:else}
            <ul>
              {#each preview.additions as a (a.importedFrameId)}
                <li>
                  <span class="mono">{a.name}</span>
                  {#if a.duplicateOf}<span class="dim">（内容与现有帧「{a.duplicateOf}」相同）</span>{/if}
                  {#if a.importedReferencedBy.length > 0}
                    <span class="dim">— 被片段 [{a.importedReferencedBy.join("、")}] 引用</span>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </div>

        {#if analysis?.applied}
          <div class="group">
            <h4>片段 / 顺序引用影响</h4>
            {#if analysis.applied.report.clipResults.length === 0 && analysis.applied.report.currentClipImpacts.length === 0}
              <div class="dim">无片段引用受影响</div>
            {:else}
              <ul id="clip-impact-list">
                {#each analysis.applied.report.clipResults as cr (cr.importedClipId)}
                  <li>
                    导入片段 <span class="mono">{cr.importedName}</span>
                    {#if cr.renamed}→ 改名为 <span class="mono">{cr.finalName}</span>{/if}
                    ：
                    {#each cr.references as r, i (r.importedFrameId + i)}
                      <span class="ref mono">{r.frameName} → {r.finalFrameName}（{EFFECT_LABEL[r.effect]}）</span>
                    {/each}
                  </li>
                {/each}
                {#each analysis.applied.report.currentClipImpacts as ci (ci.clipName + ci.frameName)}
                  <li>当前片段 <span class="mono">{ci.clipName}</span> 引用的帧 <span class="mono">{ci.frameName}</span> 内容将被替换</li>
                {/each}
              </ul>
            {/if}
          </div>
        {/if}

        {#if analysis && analysis.plan.errors.length > 0}
          <section class="errors">
            <ul>
              {#each analysis.plan.errors as err}
                <li>{err}</li>
              {/each}
            </ul>
          </section>
        {/if}
      </section>

      <!-- 3. 确认 -->
      <section class="foot">
        {#if confirmError}
          <div class="errors" id="merge-confirm-error">合并失败，已完整回滚：{confirmError}</div>
        {/if}
        <div class="row">
          <button class="primary" id="merge-confirm-btn" disabled={!canConfirm} on:click={() => void confirm()}>
            {confirming ? "合并中…" : "确认合并（原子提交）"}
          </button>
          <button on:click={onClose}>取消</button>
        </div>
      </section>
    {/if}
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 32px 16px;
    z-index: 100;
    overflow: auto;
  }
  .dialog {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px;
    width: min(860px, 100%);
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .head h2 {
    margin: 0;
    font-size: 15px;
  }
  .close {
    padding: 2px 8px;
  }
  section h3 {
    margin: 0 0 8px;
    font-size: 13px;
    color: var(--text-dim);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    margin: 6px 0;
  }
  .group {
    margin: 10px 0;
  }
  .group h4 {
    margin: 0 0 6px;
    font-size: 13px;
  }
  .count {
    margin-left: 8px;
    color: var(--accent-2);
    font-family: var(--mono);
  }
  .group ul {
    margin: 0;
    padding-left: 18px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 13px;
  }
  .dim {
    color: var(--text-dim);
    font-size: 12px;
  }
  .batch button {
    padding: 4px 10px;
    font-size: 12px;
  }
  .batch button.active {
    border-color: var(--accent);
    background: rgba(79, 140, 255, 0.15);
  }
  .conflicts {
    list-style: none;
    padding: 0 !important;
  }
  .conflict {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px 10px;
    background: var(--panel-2);
  }
  .cname {
    font-weight: 600;
    margin-bottom: 4px;
  }
  .opts {
    display: flex;
    align-items: center;
    gap: 14px;
    flex-wrap: wrap;
    font-size: 13px;
  }
  .opts label {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .rename-input {
    width: 160px;
  }
  .refs {
    margin-top: 4px;
  }
  .ref {
    display: inline-block;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 1px 6px;
    margin: 2px 4px 2px 0;
    font-size: 11px;
    color: var(--text-dim);
  }
  .errors {
    border: 1px solid var(--danger);
    background: rgba(229, 83, 75, 0.1);
    border-radius: 8px;
    padding: 8px 12px;
    font-size: 13px;
  }
  .errors h3 {
    color: var(--danger) !important;
  }
  .errors ul {
    margin: 0;
    padding-left: 18px;
  }
  .foot .row {
    justify-content: flex-end;
  }
</style>
