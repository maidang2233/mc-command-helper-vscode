import os
import re

# 目标文件夹路径（可替换为实际文件夹路径，当前目录用 '.'）
folder_path = "."

# 遍历文件夹中的所有文件
for filename in os.listdir(folder_path):
    # 匹配 "block_of_xxxxx.png" 格式的文件
    match = re.match(r"Block_of_(.*)\.png", filename)
    if match:
        # 获取匹配到的 "xxxxx" 部分
        xxxxx_part = match.group(1)
        # 构造新文件名
        new_filename = f"{xxxxx_part}_block.png"
        # 拼接文件的完整路径
        old_path = os.path.join(folder_path, filename)
        new_path = os.path.join(folder_path, new_filename)
        # 重命名文件
        os.rename(old_path, new_path)
        print(f"已重命名：{filename} -> {new_filename}")