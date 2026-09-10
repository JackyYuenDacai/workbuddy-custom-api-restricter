"""Temporary isolated UI used only by smoke.mjs; closes automatically after 90 seconds."""
import json
import sys
import threading
import tkinter as tk
import ctypes

ctypes.windll.user32.SetProcessDpiAwarenessContext.argtypes = [ctypes.c_void_p]
ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))

root = tk.Tk()
root.title(sys.argv[1])
root.geometry("700x620+120+120")
root.configure(bg="#f4f7fc")
root.attributes("-topmost", True)
root.after(1000, lambda: root.attributes("-topmost", False))
tk.Label(root, text="WorkBuddy Computer Tool Test", bg="#f4f7fc", fg="#16324f", font=("Segoe UI", 20, "bold")).pack(pady=(32, 12))
tk.Label(root, text="请点击此窗口以开始测试，然后暂时不要操作鼠标键盘。", bg="#f4f7fc", font=("Microsoft YaHei", 11)).pack(pady=8)
value = tk.StringVar()
entry = tk.Entry(root, textvariable=value, font=("Microsoft YaHei", 16), width=32)
entry.pack(pady=20)
status = tk.StringVar(value="Waiting for a test click")
button = tk.Button(root, text="Test click", font=("Segoe UI", 12), command=lambda: (status.set("Click received"), print(json.dumps({"event":"clicked"}), flush=True)))
button.pack(pady=8)
tk.Label(root, textvariable=status, bg="#f4f7fc", fg="#176d45", font=("Segoe UI", 12)).pack(pady=12)
panes = tk.Frame(root)
panes.pack(fill="both", expand=True, padx=24, pady=12)
scroll_panes = {}
for name in ("left", "right"):
    pane = tk.Text(panes, width=28, height=9, font=("Segoe UI", 11))
    pane.pack(side="left", fill="both", expand=True, padx=4)
    pane.insert("1.0", "\n".join(f"{name} scroll test row {n:03}" for n in range(1, 101)))
    pane.configure(state="disabled")
    scroll_panes[name] = pane
def report_scroll(event):
    delta = event.delta
    root.after_idle(lambda: print(json.dumps({"event": "scrolled", "delta": delta,
        "positions": {name: pane.yview()[0] for name, pane in scroll_panes.items()}}), flush=True))
for pane in scroll_panes.values():
    pane.bind("<MouseWheel>", report_scroll, add="+")
value.trace_add("write", lambda *_: print(json.dumps({"event":"text", "value":value.get()}, ensure_ascii=True), flush=True))
root.update()
entry.focus_set()
root.bind_all('<KeyPress>', lambda event: print(json.dumps({'event':'key_down','keysym':event.keysym,'state':event.state}), flush=True), add='+')
root.bind_all('<KeyRelease>', lambda event: print(json.dumps({'event':'key_up','keysym':event.keysym,'state':event.state}), flush=True), add='+')
root.bind('<ButtonRelease-1>', lambda event: print(json.dumps({'event':'mouse_up','x':event.x_root,'y':event.y_root,'widget':str(event.widget)}), flush=True), add='+')
print(json.dumps({"event":"ready", "entry_x":entry.winfo_rootx()+50, "entry_y":entry.winfo_rooty()+15,
                  "button_x":button.winfo_rootx()+35, "button_y":button.winfo_rooty()+15,
                  "scroll_x":scroll_panes["right"].winfo_rootx()+80, "scroll_y":scroll_panes["right"].winfo_rooty()+60}), flush=True)
closed = threading.Event()
threading.Thread(target=lambda: (sys.stdin.readline(), closed.set()), daemon=True).start()
def poll_close():
    if closed.is_set():
        root.destroy()
    else:
        root.after(100, poll_close)
root.after(100, poll_close)
root.after(90000, root.destroy)
root.mainloop()
