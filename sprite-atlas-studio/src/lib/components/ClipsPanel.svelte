<script lang="ts">
  import { clips, createClip, deleteClip, frames, selectClip, selectedClipId } from "../core/store";

  let newName = "";

  function frameName(id: string): string {
    return $frames.find((f) => f.id === id)?.name ?? "?";
  }
</script>

<div class="panel" id="clips-panel">
  <h2>片段（顺序引用）</h2>
  {#if $clips.length === 0}
    <div class="empty">尚无片段。片段是一组有序的帧引用，可独立播放，并参与工程合并。</div>
  {:else}
    <div class="clip-list">
      {#each $clips as clip (clip.id)}
        <div class="clip-item" class:selected={$selectedClipId === clip.id} data-clip-name={clip.name}>
          <button
            class="play"
            title={$selectedClipId === clip.id ? "正在播放该片段，点击取消" : "播放该片段"}
            on:click={() => selectClip($selectedClipId === clip.id ? null : clip.id)}
          >
            {$selectedClipId === clip.id ? "■" : "▶"}
          </button>
          <span class="meta">
            <span class="name" title={clip.name}>{clip.name}</span>
            <span class="dim mono">{clip.frameIds.length} 帧</span>
          </span>
          <button class="danger" title="删除片段" on:click={() => deleteClip(clip.id)}>✕</button>
        </div>
        {#if $selectedClipId === clip.id}
          <div class="clip-frames mono">
            {#each clip.frameIds as fid, i (fid + i)}
              <span class="chip">{i + 1}. {frameName(fid)}</span>
            {/each}
          </div>
        {/if}
      {/each}
    </div>
  {/if}
  <div class="new-clip">
    <input type="text" placeholder="片段名称（可选）" bind:value={newName} />
    <button id="create-clip-btn" disabled={$frames.length === 0} on:click={() => { createClip(newName); newName = ""; }}>
      以全部帧新建片段
    </button>
  </div>
</div>

<style>
  .empty {
    color: var(--text-dim);
    padding: 4px 0 8px;
    font-size: 12px;
  }
  .clip-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .clip-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--panel-2);
  }
  .clip-item.selected {
    border-color: var(--accent);
  }
  .play {
    padding: 2px 8px;
  }
  .meta {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
  }
  .dim {
    color: var(--text-dim);
  }
  .clip-frames {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 4px 2px 6px;
  }
  .chip {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1px 8px;
    color: var(--text-dim);
    font-size: 11px;
  }
  .new-clip {
    display: flex;
    gap: 8px;
    margin-top: 10px;
  }
  .new-clip input {
    flex: 1;
    min-width: 0;
  }
</style>
