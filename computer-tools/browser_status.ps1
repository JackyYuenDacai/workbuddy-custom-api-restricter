# Fixed read-only UI Automation query. Invoked as -Command by the Python bridge.
# Never inspect web document descendants or read arbitrary edit/password fields.
param([long]$WindowId)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$WindowId)
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$queue = [System.Collections.Generic.Queue[object]]::new()
$queue.Enqueue(@($root, 0))
$visited = 0
$result = @{ url = $null; url_source = $null; address_bar_text = $null; note = 'Address bar unavailable through UI Automation; verify a fresh screenshot.' }
while ($queue.Count -gt 0 -and $visited -lt 400) {
    $entry = $queue.Dequeue()
    $element = $entry[0]
    $depth = $entry[1]
    $visited++
    $current = $element.Current
    if ($current.ControlType -eq [System.Windows.Automation.ControlType]::Document) { continue }
    if ($current.ControlType -in @([System.Windows.Automation.ControlType]::Edit, [System.Windows.Automation.ControlType]::ComboBox) -and !$current.IsPassword -and !$current.IsOffscreen) {
        $id = $current.AutomationId
        if ($id -in @('urlbar-input', 'urlbar', 'addressEditBox', 'omnibox')) {
            $pattern = $null
            if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
                $value = $pattern.Current.Value
                if ($value -match '^https?://') {
                    $result = @{ url = $value; url_source = 'browser_chrome_uia'; address_bar_text = $null; note = 'Address bar value is not proof that page content finished loading.' }
                    break
                }
                if ($value.Length -le 2000) {
                    $result = @{ url = $null; url_source = $null; address_bar_text = $value; note = 'Address bar exposes text (possibly search terms or an unsubmitted edit), not a verified HTTP(S) URL. Verify screenshot.' }
                    break
                }
            }
        }
    }
    if ($depth -ge 12) { continue }
    $child = $walker.GetFirstChild($element)
    while ($null -ne $child -and $queue.Count -lt 400) {
        $queue.Enqueue(@($child, ($depth + 1)))
        $child = $walker.GetNextSibling($child)
    }
}
$result | ConvertTo-Json -Compress
