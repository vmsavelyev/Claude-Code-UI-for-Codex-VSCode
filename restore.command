#!/bin/zsh
set -e
codex_ui_bundle_dir="${0:A:h}"
for codex_ui_node in /opt/homebrew/bin/node /usr/local/bin/node; do
  if [[ -x "$codex_ui_node" ]]; then
    exec "$codex_ui_node" "$codex_ui_bundle_dir/restore.js" "$@"
  fi
done
codex_ui_node=$(command -v node || true)
if [[ -n "$codex_ui_node" ]]; then
  exec "$codex_ui_node" "$codex_ui_bundle_dir/restore.js" "$@"
fi
print -u2 'Не найден установленный Node.js. Комплект не изменил файлы и ничего не устанавливал.'
exit 1
