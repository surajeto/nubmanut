$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:8000/")
$listener.Start()
Write-Host "Server is running at http://localhost:8000/"
Write-Host "Press Ctrl+C to stop."

try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response
        
        $localPath = (Get-Location).Path + $request.Url.LocalPath.Replace("/", "\")
        if ($localPath.EndsWith("\")) { $localPath += "index.html" }
        
        if (Test-Path $localPath -PathType Leaf) {
            $ext = [System.IO.Path]::GetExtension($localPath).ToLower()
            $mime = "text/plain"
            switch ($ext) {
                ".html" { $mime = "text/html" }
                ".css"  { $mime = "text/css" }
                ".js"   { $mime = "application/javascript" }
            }
            $response.ContentType = $mime
            
            $content = [System.IO.File]::ReadAllBytes($localPath)
            $response.ContentLength64 = $content.Length
            $response.OutputStream.Write($content, 0, $content.Length)
        } else {
            $response.StatusCode = 404
        }
        $response.Close()
    }
} finally {
    $listener.Stop()
    $listener.Close()
}
