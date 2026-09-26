<script lang="ts">
  import {
    applyBatchDecision,
    buildMergePlan,
    validateConflictName,
    type ConflictDecision,
    type ConflictItem,
    type MergePreview
  } from "../core/merge";
  import { busy, confirmMerge, createPreviewFromCurrent, prepareImportedMergeProject } from "../core/store";

  export let open = false;
  export let close = () => {};

  let fileInput: HTMLInputElement;
  let importedName = "";
  let preview: MergePreview | null = null;
  let loading = false;
  let error = "";
  let successId = "";
  let derivedStats: { assets: number; refs: number; added: number; invalid: boolean } | null = null;

  function closeDialog() {
    open = false;
    preview = null;
    error = "";
    importedName = "";
    close();
  }

  async function onFilePicked(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    loading = true;
    error = "";
    preview = null;
    try {
      importedName = file.name;
      const imported = await prepareImportedMergeProject(file);
      preview = await createPreviewFromCurrent(imported);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  function batch(decision: ConflictDecision) {
    if (!preview) return;
    applyBatchDecision(preview, decision);
    preview = preview;
  }

  function setDecision(item: ConflictItem, decision: ConflictDecision) {
    item.decision = decision;
    if (decision === "rename-import" && !item.newName) item.newName = item.defaultNewName;
    if (preview) preview = preview;
  }

  function renameError(item: ConflictItem): string | null {
    return preview && item.decision === "rename-import" ? validateConflictName(preview, item) : null;
  }

  async function confirm() {
    if (!preview) return;
    error = "";
    for (const c of preview.conflicts) {
      const bad = renameError(c);
      if (bad) {
        error = `“${c.name}”：${bad}`;
        return;
      }
    }
    try {
      // 先纯函数验证引用；随后 store 会重新打包并用 IndexedDB 事务原子提交。
      buildMergePlan(preview, preview.conflicts.map((c) => ({
        name: c.name,
        decision: c.decision,
        ...(c.decision === "rename-import" ? { newName: c.newName.trim() } : {})
      })));
      const summary = await confirmMerge(preview, preview.conflicts.map((c) => ({
        name: c.name,
        decision: c.decision,
        ...(c.decision === "rename-import" ? { newName: c.newName.trim() } : {})
      })));
      successId = summary.id;
      closeDialog();
    } catch (err) {
      // confirmMerge 已在页面 toast 中展示；对话框保持打开，当前工程未改变。
      error = err instanceof Error ? err.message : String(err);
    }
  }

  function cancel() {
    closeDialog();
  }

  $: derivedStats = preview
    ? (() => {
        try {
          const plan = buildMergePlan(
            preview,
            preview.conflicts.map((c) => ({
              name: c.name,
              decision: c.decision,
              ...(c.decision === "rename-import" ? { newName: c.newName.trim() } : {})
            }))
          );
          return {
            assets: plan.summary.finalFrameCount,
            refs: plan.summary.finalSequenceLength,
            added: plan.summary.addedCount,
            invalid: false
          };
        } catch {
          return { assets: preview.stats.finalAssets, refs: preview.stats.finalSequenceLength, added: preview.importedOnly.length, invalid: true };
        }
      })()
    : null;
</script>

<svelte:window on:keydown={(e) => e.key === "Escape" && open && cancel()} />

{#if open}
  <div
    class="overlay"
    role="dialog"
    aria-modal="true"
    aria-label="合并两个本地精灵工程"
    tabindex="-1"
    on:click|self={cancel}
    on:keydown={(e) => e.key === "Escape" && cancel()}
  >
    <section class="dialog panel">
      <header>
        <h2>合并两个本地工程</h2>
        <button class="close" on:click={cancel}>×</button>
      </header>

      <div class="picker">
        <input
          bind:this={fileInput}
          id="merge-project-input"
          type="file"
          accept=".json,application/json"
          hidden
          on:change={(e) => void onFilePicked(e)}
        />
        <button id="merge-pick-btn" disabled={loading || $busy} on:click={() => fileInput.click()}>
          选择导入工程 atlas.json
        </button>
        <span class="dim">{importedName || "当前工程将作为合并目标，图片仍全部留在本机"}</span>
      </div>

      {#if loading}
        <div class="state">正在解码图片、计算内容摘要…</div>
      {:else if error}
        <div class="state error" id="merge-preview-error">{error}</div>
      {/if}

      {#if preview}
        <div class="stats mono" id="merge-stats" class:invalid={derivedStats?.invalid}>
          当前 {preview.stats.currentAssets} 资源 / {preview.current.frames.length} 引用 ·
          导入 {preview.stats.importedAssets} 资源 / {preview.imported.frames.length} 引用 ·
          合并后 {derivedStats?.assets ?? preview.stats.finalAssets} 资源 / {derivedStats?.refs ?? preview.stats.finalSequenceLength} 引用
          {derivedStats?.invalid ? "· 请修正重命名" : ""}
        </div>

        <div class="content">
          <section>
            <h3>同名同内容（只保留一份并合并引用）</h3>
            {#if preview.identical.length === 0}
              <p class="dim">无</p>
            {:else}
              <table class="merge-table" id="merge-identical-table">
                <thead><tr><th>保留名称</th><th>导入别名</th><th>引用</th></tr></thead>
                <tbody>
                  {#each preview.identical as item (item.digest + item.name)}
                    <tr>
                      <td>{item.name}</td>
                      <td>{item.aliases.length ? item.aliases.join("、") : "—"}</td>
                      <td class="mono">当前 {item.currentReferenceCount} · 导入 {item.importedReferenceCount}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            {/if}

            <h3>同名不同内容冲突</h3>
            <div class="batch">
              <span>批量规则：</span>
              <button on:click={() => batch("keep-current")}>全部保留当前</button>
              <button on:click={() => batch("adopt-import")}>全部采用导入</button>
              <button class="primary" on:click={() => batch("rename-import")}>全部重命名导入</button>
              <span class="dim">批量应用后仍可逐项覆盖</span>
            </div>
            {#if preview.conflicts.length === 0}
              <p class="dim">无冲突</p>
            {:else}
              <div class="conflicts" id="merge-conflicts">
                {#each preview.conflicts as item (item.name)}
                  <fieldset class="conflict" data-conflict={item.name}>
                    <legend>
                      {item.name}
                      {item.importedAliases.length ? `（导入别名 ${item.importedAliases.join("、")}）` : ""}
                      <span class="dim mono">引用：当前 {item.currentReferenceCount} / 导入 {item.importedReferenceCount}</span>
                    </legend>
                    <div class="thumbs">
                      <label><input type="radio" name={`decision-${item.name}`} checked={item.decision === "keep-current"} on:change={() => setDecision(item, "keep-current")} /> 保留当前</label>
                      <label><input type="radio" name={`decision-${item.name}`} checked={item.decision === "adopt-import"} on:change={() => setDecision(item, "adopt-import")} /> 采用导入</label>
                      <label><input type="radio" name={`decision-${item.name}`} checked={item.decision === "rename-import"} on:change={() => setDecision(item, "rename-import")} /> 重命名导入</label>
                    </div>
                    {#if item.decision === "rename-import"}
                      <input
                        class="rename"
                        data-rename-for={item.name}
                        type="text"
                        bind:value={item.newName}
                        on:input={() => preview = preview}
                      />
                      {#if renameError(item)}
                        <div class="small-error" data-rename-error={item.name}>{renameError(item)}</div>
                      {/if}
                    {/if}
                  </fieldset>
                {/each}
              </div>
            {/if}

            <h3>导入工程独有帧（{preview.importedOnly.length}）</h3>
            <div class="added" id="merge-imported-only">
              {#each preview.importedOnly as item (item.digest + item.name)}
                <span>{item.name}{item.aliases?.length ? `（别名 ${item.aliases.join("、")}）` : ""} <em class="dim mono">{item.width}×{item.height} ×{item.referenceCount}</em></span>
              {/each}
              {#if preview.importedOnly.length === 0}<span class="dim">无</span>{/if}
            </div>
          </section>

          <section>
            <h3>片段 / 顺序引用影响</h3>
            <div class="refs" id="merge-reference-impacts">
              {#each preview.referenceImpacts as ref, i (i)}
                <div class="ref">
                  <b>{ref.source === "current" ? "当前" : "导入"} · {ref.location}</b>
                  <span>{ref.fromName} → {ref.toName}</span>
                  {#if ref.occurrence}<span class="dim mono">#{ref.occurrence}</span>{/if}
                  <em class="dim">{ref.reason}</em>
                </div>
              {/each}
            </div>
          </section>
        </div>
      {/if}

      <footer>
        <span class="dim" id="merge-success-id">{successId ? `上次合并 ${successId}` : ""}</span>
        <span class="spacer"></span>
        <button on:click={cancel}>取消</button>
        <button id="merge-confirm-btn" class="primary" disabled={!preview || loading || $busy} on:click={() => void confirm()}>
          确认原子合并并重新打包
        </button>
      </footer>
    </section>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.62);
    z-index: 50;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }
  .dialog {
    width: min(1120px, 100%);
    max-height: 92vh;
    display: flex;
    flex-direction: column;
    padding: 0;
    overflow: hidden;
  }
  header,
  footer {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
  }
  footer {
    border-bottom: none;
    border-top: 1px solid var(--border);
  }
  h2 {
    margin: 0;
    font-size: 16px;
  }
  h3 {
    font-size: 13px;
    margin: 14px 0 8px;
  }
  .close {
    margin-left: auto;
    font-size: 20px;
    line-height: 1;
  }
  .spacer { flex: 1; }
  .picker,
  .batch,
  .state {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px 0;
    flex-wrap: wrap;
  }
  .dim,
  .small-error { color: var(--text-dim); font-size: 12px; }
  .error,
  .small-error { color: var(--danger); }
  .stats {
    color: var(--text-dim);
    padding: 12px 16px 0;
  }
  .stats.invalid { color: var(--danger); }
  .content {
    display: grid;
    grid-template-columns: 1.15fr 0.85fr;
    gap: 16px;
    padding: 0 16px 12px;
    overflow: auto;
  }
  .merge-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  th, td {
    text-align: left;
    padding: 5px 6px;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }
  .conflicts {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .conflict {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .thumbs {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
  }
  .rename { width: 260px; }
  .added,
  .refs {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .added {
    flex-direction: row;
    flex-wrap: wrap;
  }
  .added span {
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 3px 8px;
    font-size: 12px;
  }
  .ref {
    display: grid;
    grid-template-columns: 92px 1fr auto;
    gap: 6px;
    border-bottom: 1px solid var(--border);
    padding: 5px 0;
    font-size: 12px;
  }
  .ref em {
    grid-column: 1 / -1;
    font-style: normal;
  }
  @media (max-width: 860px) {
    .content { grid-template-columns: 1fr; }
  }
</style>
