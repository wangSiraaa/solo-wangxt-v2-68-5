<script lang="ts">
  import { mergeHistory, undoLatestMerge } from "../core/store";

  $: ordered = [...$mergeHistory].sort((a, b) => b.ts - a.ts);
  $: latestUndoableId = ordered.find((m) => !m.undone && !m.imported)?.id ?? null;

  function fmtTime(ts: number): string {
    return new Date(ts).toLocaleString();
  }

  const ACTION_LABEL: Record<string, string> = {
    "keep-current": "保留当前",
    "use-imported": "采用导入",
    rename: "重命名"
  };
</script>

<div class="panel" id="merge-history-panel">
  <h2>合并记录</h2>
  {#if ordered.length === 0}
    <div class="empty">尚无合并记录。</div>
  {:else}
    <div class="records">
      {#each ordered as m (m.id)}
        <div class="record" class:undone={m.undone} data-merge-id={m.id}>
          <div class="line1">
            <span class="src" title={m.source.name}>⇐ {m.source.name}</span>
            <span class="dim mono">{fmtTime(m.ts)}</span>
          </div>
          <div class="line2 mono">
            相同 {m.summary.identical} · 冲突 {m.summary.conflicts} · 新增 {m.summary.added} · 片段 {m.summary.clipsAdded}
          </div>
          {#if Object.keys(m.decisions).length > 0}
            <div class="decisions">
              {#each Object.entries(m.decisions) as [name, action] (name)}
                <span class="chip mono" title={m.renames[name] ? `→ ${m.renames[name]}` : ""}>
                  {name}：{ACTION_LABEL[action] ?? action}{m.renames[name] ? ` → ${m.renames[name]}` : ""}
                </span>
              {/each}
            </div>
          {/if}
          <div class="line3">
            {#if m.undone}
              <span class="badge undone-badge">已撤销</span>
            {:else if m.imported}
              <span class="badge">导入的历史（不可撤销）</span>
            {:else if m.id === latestUndoableId}
              <button class="danger" id="undo-merge-btn" on:click={() => void undoLatestMerge()}>撤销此次合并</button>
            {:else}
              <span class="badge">仅可撤销最近一次</span>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .empty {
    color: var(--text-dim);
    font-size: 12px;
  }
  .records {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 300px;
    overflow: auto;
  }
  .record {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px 10px;
    background: var(--panel-2);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .record.undone {
    opacity: 0.6;
  }
  .line1 {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    font-size: 13px;
  }
  .src {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .line2 {
    color: var(--text-dim);
    font-size: 11px;
  }
  .decisions {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .chip {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1px 8px;
    font-size: 11px;
    color: var(--text-dim);
  }
  .line3 {
    display: flex;
    justify-content: flex-end;
  }
  .badge {
    font-size: 11px;
    color: var(--text-dim);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1px 8px;
  }
  .undone-badge {
    color: var(--danger);
    border-color: var(--danger);
  }
</style>
