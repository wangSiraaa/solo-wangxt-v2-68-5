<script lang="ts">
  import {
    createProject,
    currentProjectId,
    deleteProject,
    projects,
    switchProject
  } from "../core/store";

  export let onOpenMerge: () => void;

  let newName = "";

  function onSwitch(e: Event) {
    const id = (e.currentTarget as HTMLSelectElement).value;
    void switchProject(id);
  }

  function onCreate() {
    void createProject(newName.trim() || undefined);
    newName = "";
  }

  function onDelete() {
    const id = $currentProjectId;
    if (!id) return;
    const name = $projects.find((p) => p.id === id)?.name ?? "";
    if (confirm(`确定删除工程「${name}」？其帧、片段与合并记录将一并删除。`)) {
      void deleteProject(id);
    }
  }
</script>

<div class="project-bar">
  <label for="project-select">当前工程</label>
  <select id="project-select" value={$currentProjectId ?? ""} on:change={onSwitch}>
    {#each $projects as p (p.id)}
      <option value={p.id}>{p.name}（{p.frameCount} 帧 / {p.clipCount} 片段）</option>
    {/each}
  </select>

  <input type="text" placeholder="新工程名称" bind:value={newName} />
  <button id="new-project-btn" on:click={onCreate}>新建工程</button>
  <button class="danger" id="delete-project-btn" on:click={onDelete}>删除工程</button>

  <span class="sep"></span>

  <button class="primary" id="merge-btn" on:click={onOpenMerge} title="将另一个本地工程或 JSON 文件合并进当前工程">
    合并工程…
  </button>
</div>

<style>
  .project-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    padding: 8px 16px 0;
  }
  .project-bar label {
    color: var(--text-dim);
    font-size: 13px;
  }
  .sep {
    width: 1px;
    height: 22px;
    background: var(--border);
  }
  input[type="text"] {
    width: 140px;
  }
</style>
