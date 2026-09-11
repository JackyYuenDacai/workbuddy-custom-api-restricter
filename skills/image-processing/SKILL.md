---
name: image-processing
description: Process local images with automatic background removal, transparency, resizing, rotation, format conversion, and compositing through WorkBuddy's image_process tool.
---

Use `image_process` for local image edits. Set `remove_background=true` for deep-learning segmentation via rembg/U²-Net; choose `model="u2net_human_seg"` for people or `isnet-general-use` for general objects. Crop with `crop_left`, `crop_top`, `crop_width`, and `crop_height`; omitted crop dimensions extend to the image edge. Resize with `resize_width` and/or `resize_height` after cropping. The first deep-removal use may download model weights and requires `rembg` plus `onnxruntime`. Save transparent results as PNG or WEBP. Use `background_color="white"` or JPEG only when a solid background is desired. Confirm input and output paths and report dimensions, format, and method.
