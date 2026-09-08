# Fixed read-only query: identify the focused hidden-icons chevron, never an
# arbitrary notification icon. Called after Win+B; no input is sent by this file.
param([long]$WindowId)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$WindowId)
$focused = [System.Windows.Automation.AutomationElement]::FocusedElement
$identified = $false
$withinTaskbar = $false
if ($null -ne $focused -and $focused.Current.HasKeyboardFocus -and !$focused.Current.IsPassword) {
    $element = $focused
    $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
    for ($depth = 0; $depth -lt 16 -and $null -ne $element; $depth++) {
        if ([System.Windows.Automation.Automation]::Compare($element, $root)) {
            $withinTaskbar = $true
            break
        }
        $current = $element.Current
        $knownClass = $current.ClassName -eq 'SystemTray.ChevronIconView'
        $knownNativeId = $current.ClassName -eq 'Button' -and $current.AutomationId -eq '1502'
        $knownLabel = $current.Name -in @('Show hidden icons', 'Show Hidden Icons', '显示隐藏的图标', '显示隐藏图标', '顯示隱藏的圖示', '顯示隱藏圖示')
        if (!$current.IsOffscreen -and $current.IsEnabled -and
            ($knownClass -or $knownNativeId -or ($knownLabel -and $current.ControlType -eq [System.Windows.Automation.ControlType]::Button))) {
            $identified = $true
        }
        $element = $walker.GetParent($element)
    }
}
@{ chevron_focused = ($withinTaskbar -and $identified) } | ConvertTo-Json -Compress
