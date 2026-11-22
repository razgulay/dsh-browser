# Nâng cấp dsh-browser (runbook cho bản merge `pointer-restore`)

> Đọc file này trước khi nâng cấp. Không cần nhớ gì khác.

## Bối cảnh: repo này là gì

`razgulay/dsh-browser` là fork của `omdsh-dev/dsh-browser` (upstream), và trước đó
là fork của `graydovee/dsh-browser`. Nhánh `pointer-restore` là **bản lai** do
chúng ta tự dựng:

- **Nền:** upstream `v0.1.7` (`305efcb`) — UI polish, uninstall flow, session
  purge fix, devtools refactor, clipboard pipeline mới, DSH `0.2.2-rc.5`.
- **Cộng thêm:** tầng input pointer của graydovee — `point` toạ độ, `drag`/`move`/
  `down`/`up`, `to`+`steps`, `deltaX`/`deltaY` wheel gesture.

Tầng pointer đó **upstream đã chủ động xóa** ở commit `e52eb75`
("refactor: simplify browser input and clipboard delivery"). Đó là lý do phải
bảo vệ nó mỗi lần nâng cấp. Nếu merge mù, Git lấy phía upstream và bạn mất sạch.

Các remote hiện có (đừng giả định tên, kiểm bằng `git remote -v`):

| remote | URL | vai trò |
|---|---|---|
| `origin` | `razgulay/dsh-browser` | repo của bạn — nơi push |
| `upstream` | `omdsh-dev/dsh-browser` | nguồn cập nhật chính |
| `graydovee` | `graydovee/dsh-browser` | fork gốc của tầng pointer |

## 11 file phải bảo vệ

Merge xong, nếu các file này bị lấy từ upstream thì tầng pointer đã chết. Danh
sách chính xác (đã kiểm):

```
extensions/dsh-browser/package.json                       (dep ml-matrix)
extensions/dsh-browser/src/background/authorization.ts
extensions/dsh-browser/src/background/debugger-broker.ts
extensions/dsh-browser/src/background/debugger-geometry.ts
extensions/dsh-browser/src/background/input-actions.ts
extensions/dsh-browser/src/background/input-state.ts
extensions/dsh-browser/src/background/tools.ts
extensions/dsh-browser/src/content/actions.ts
extensions/dsh-browser/src/content/find.ts
extensions/dsh-browser/src/content/input-support.ts
extensions/dsh-browser/src/shared/frame-geometry.ts
extensions/dsh-browser/src/shared/input-setup.ts
extensions/dsh-browser/tests/frame-geometry.spec.ts
packages/browser/bridge-browser/src/tools.ts               (schema point/drag/wheel)
packages/browser/bridge-browser/tests/tools.spec.ts
```

## Quy trình nâng cấp

### 1. Kiểm tra trạng thái trước khi làm

```powershell
cd C:\Users\Lucy\dsh-browser
git status                     # phải sạch; nếu bẩn thì commit hoặc stash trước
git branch --show-current      # phải là pointer-restore
git fetch upstream --tags
git log --oneline -1 upstream/main
```

### 2. Xem upstream có gì mới

```powershell
git log --oneline pointer-restore..upstream/main
```

Nếu rỗng → không có gì mới, dừng ở đây.

### 3. Merge

```powershell
git merge upstream/main
```

### 4. Nếu có conflict

Xem file nào vướng:

```powershell
git diff --name-only --diff-filter=U
```

Nguyên tắc quyết định:

- File **nằm trong danh sách 11 file bảo vệ** → giữ phía ta:
  `git checkout --ours <file> && git add <file>`
- Mọi file khác → lấy phía upstream:
  `git checkout --theirs <file> && git add <file>`

Sau đó đọc lại diff của từng file trong danh sách bảo vệ để chắc upstream không
thêm thứ gì đáng giữ. Nếu có, ghép tay.

### 5. Nếu test schema đỏ

Triệu chứng quen thuộc: `tools.spec.ts` báo
`expect(scroll.required).toContain('direction')` thất bại. Nguyên nhân: schema
của ta có `direction` optional (vì `point` thay thế được), còn test lấy từ
upstream giả định nó required.

**Sửa test, không sửa schema.** Test đúng phải là:

```ts
expect(scroll.properties.point).toBeDefined()
expect(scroll.required ?? []).not.toContain('direction')
```

### 6. Kiểm chứng bắt buộc

```powershell
pnpm install
pnpm run typecheck
pnpm run build
pnpm run test          # kỳ vọng: 79 files / 684 tests xanh
pnpm run check:runtime
pnpm run test:smoke    # boot DSH thật trong DSH_HOME tạm — bằng chứng mạnh nhất
```

Nếu `test:smoke` đỏ, đọc thông điệp trước khi sửa. Hai lỗi portability Windows
đã biết (đã fix, nhưng có thể tái xuất nếu upstream viết lại script):

1. `chmod 0` **không** chặn đọc trên NTFS → phải thay `.git/config` bằng
   directory để tạo lỗi Git thật.
2. Node trên Windows **không có** graceful `SIGTERM` → contract "inbox splice"
   chỉ đúng trên POSIX, phải guard `process.platform !== 'win32'`.

### 7. Kiểm tra DSH version khớp

```powershell
node -p "require('C:/Users/Lucy/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/package.json').version"
(Get-Content packages/browser/bridge-browser/package.json -Raw | ConvertFrom-Json).engines.dsh
```

Hai số này phải khớp. Nếu `engines.dsh` đòi bản cao hơn đang cài:

```powershell
npm install -g @deepseek-ai/dsh@<version>
```

**Sau đó phải restart DSH** thì bản mới mới vào RAM. Kiểm tra bằng:

```powershell
(Invoke-RestMethod "http://127.0.0.1:3080/ext/bridge-config").pid
```

PID phải khác lần trước, và `Get-Process -Id <pid>` phải có `StartTime` mới.

### 8. Cài vào profile

```powershell
# Junction trong profile phải trỏ về checkout này
$link = "$env:USERPROFILE\.dsh\profiles\web\.dsh-browser-source"
(Get-Item $link -Force).Target     # kỳ vọng: C:\Users\Lucy\dsh-browser\packages\browser\bridge-browser
```

Nếu sai, sửa (dùng `cmd /c rmdir` cho junction, **không** `Remove-Item -Recurse`
vì nó xoá luôn thư mục đích):

```powershell
cmd /c rmdir "$env:USERPROFILE\.dsh\profiles\web\.dsh-browser-source"
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\web\.dsh-browser-source" `
  -Target "C:\Users\Lucy\dsh-browser\packages\browser\bridge-browser"
```

Đồng bộ extension. **Cẩn thận:** `robocopy /MIR` xóa `install-info.json` — phải
tạo lại sau:

```powershell
$src = "C:\Users\Lucy\dsh-browser\extensions\dsh-browser\dist"
$dst = "$env:USERPROFILE\.dsh\browser-extension"
robocopy $src $dst /MIR /NFL /NDL /NJH /NJS /NP
node C:\Users\Lucy\dsh-browser\scripts\write-install-info.mjs `
  "$dst\install-info.json" checkout "C:\Users\Lucy\dsh-browser" "$env:USERPROFILE\.dsh"
```

Rồi mở `chrome://extensions` → **Reload** extension.

### 9. Nghiệm thu bằng tay (quan trọng nhất)

Restart DSH + reload extension xong, gọi thử ba tool chỉ có trong tầng pointer.
Cả ba phải trả `(trusted)`:

```
browser_scroll  { deltaY: 300, point: {x: 400, y: 300} }
   → "wheel delta 0,300 at 400,300 (trusted)"

browser_click   { action: "move", point: {x: 500, y: 400} }
   → "move at point 500,400 (trusted)"

browser_click   { action: "drag", point: {x: 300, y: 500}, to: {x: 600, y: 550}, steps: 12 }
   → "drag at point 300,500 (trusted)"
```

Nếu wheel trả lỗi *"needs its page to be the active tab"* — đó là **dấu hiệu
tốt**, chứng tỏ logic guard của fork còn sống. Gọi
`browser_follow_tab { activate: true }` rồi thử lại.

### 10. Commit và push

```powershell
git add -A
git commit -m "chore: merge upstream/main into pointer-restore"
git push
git tag -a v<version>-forkmerge -m "upstream <tag> + fork pointer layer"
git push origin v<version>-forkmerge
```

## Tình huống: graydovee cập nhật

**Đừng merge nhánh hắn.** Nhánh đó dựa trên nền cũ; merge sẽ kéo lùi hàng loạt
file upstream. Thay vào đó:

```powershell
git fetch graydovee
git log --oneline graydovee-main..graydovee/main
```

Xem hắn thêm gì. Nếu chỉ bump version, bỏ qua. Nếu có tính năng pointer mới,
`git cherry-pick` từng commit.

## Bẫy đã gặp, đừng lặp lại

- **`cd` không giữ giữa các lệnh pwsh.** Dùng `workdir` của tool.
- **PowerShell 5.1 không có `utf8NoBOM`.** Dùng Node hoặc
  `New-Object System.Text.UTF8Encoding($false)`.
- **`install.ps1` cần UTF-8 BOM** (Windows PowerShell 5.1 đọc tiếng Trung).
  Sau khi sửa file này phải kiểm `$bytes[0..2] -eq 239,187,191`. Có test canh:
  `tests/updates.spec.ts`.
- **`Copy-Item -Recurse` hỏng khi gặp junction.** Dùng `robocopy`.
- **Repository checkout ở `C:\Users\Lucy\dsh-browser`, KHÔNG phải
  `C:\Users\Lucy\.dsh\dsh-browser`** (cái sau là bản managed cũ, đừng đụng).

## Kiểm tra nhanh "tầng pointer còn sống không"

Không cần chạy gì phức tạp:

```powershell
git grep -c "POINT_PARAMETER" -- packages/browser/bridge-browser/src/tools.ts
git grep -c "framePointMapper" -- "extensions/dsh-browser/src/**"
Test-Path extensions/dsh-browser/src/shared/frame-geometry.ts
Test-Path extensions/dsh-browser/src/background/debugger-geometry.ts
```

Cả bốn phải có kết quả. Nếu `frame-geometry.ts` không tồn tại → tầng pointer đã
chết, quay lại bước 4.
