<script lang="ts">
  let { html }: { html: string } = $props();
</script>

<div class="markdown text-sm leading-7 wrap-anywhere">
  {@html html}
</div>

<style>
  .markdown :global(h1),
  .markdown :global(h2) {
    font-size: 1.125rem;
    font-weight: 600;
    margin-block: 1.5rem 0.75rem;
  }
  .markdown :global(h3),
  .markdown :global(h4) {
    font-weight: 600;
    margin-block: 1rem 0.5rem;
  }
  .markdown :global(p),
  .markdown :global(ul),
  .markdown :global(ol),
  .markdown :global(pre),
  .markdown :global(blockquote),
  .markdown :global(table) {
    margin-block: 0.75rem;
  }
  .markdown :global(ul) {
    list-style: disc;
    padding-left: 1.5rem;
  }
  .markdown :global(ol) {
    list-style: decimal;
    padding-left: 1.5rem;
  }
  .markdown :global(li) {
    margin-block: 0.25rem;
  }
  .markdown :global(a) {
    text-decoration: underline;
    text-underline-offset: 0.2em;
  }
  .markdown :global(a:focus-visible) {
    outline: 2px solid var(--ring);
    outline-offset: 2px;
  }
  .markdown :global(pre) {
    overflow-x: auto;
    padding: 1rem;
    border-radius: var(--radius);
    background: var(--muted);
  }
  .markdown :global(code) {
    font-size: 0.8125rem;
  }
  .markdown :global(blockquote) {
    border-left: 3px solid var(--border);
    padding-left: 1rem;
    color: var(--muted-foreground);
  }
  .markdown :global(table) {
    display: block;
    max-width: 100%;
    overflow-x: auto;
    border-collapse: collapse;
  }
  .markdown :global(th),
  .markdown :global(td) {
    border: 1px solid var(--border);
    padding: 0.25rem 0.75rem;
    text-align: left;
  }
  .markdown :global(img) {
    max-width: 100%;
    height: auto;
  }
  .markdown :global(hr) {
    border-color: var(--border);
    margin-block: 1.5rem;
  }
</style>
