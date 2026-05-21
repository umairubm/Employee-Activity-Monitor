Add-Type -AssemblyName System.Windows.Forms,System.Drawing
 = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
 = New-Object System.Drawing.Bitmap .Width, .Height
 = [System.Drawing.Graphics]::FromImage()
.CopyFromScreen(.X, .Y, 0, 0, .Size)
 = New-Object System.IO.MemoryStream
.Save(, [System.Drawing.Imaging.ImageFormat]::Jpeg)
[Convert]::ToBase64String(.ToArray())