import tkinter as tk
root = tk.Tk()
lbl = tk.Label(root, text="Test", state="normal")
print(f"STATE IS: '{lbl.cget('state')}'")
