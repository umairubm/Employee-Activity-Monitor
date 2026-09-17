import tkinter as tk
root = tk.Tk()
b = tk.Button(root, text="Test", bg="blue", fg="white", state="normal")
b.pack()
print(b.cget("state"))
