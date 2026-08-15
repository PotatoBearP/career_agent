param(
  [int]$Port = 8790
)

py -3 "$PSScriptRoot/server.py" --port $Port
