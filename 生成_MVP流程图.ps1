Add-Type -AssemblyName System.Drawing

$out = 'C:\Users\kelly\Documents\ChatGPT\购物智能体 2\沉浸式购物智能体_MVP流程图.png'
$w = 1600
$h = 1280
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.Clear([System.Drawing.Color]::White)

$black = [System.Drawing.Color]::FromArgb(25,25,25)
$gray = [System.Drawing.Color]::FromArgb(90,90,90)
$pen = New-Object System.Drawing.Pen($black, 3)
$pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
$font = New-Object System.Drawing.Font('Microsoft YaHei UI', 25, [System.Drawing.FontStyle]::Regular)
$smallFont = New-Object System.Drawing.Font('Microsoft YaHei UI', 20, [System.Drawing.FontStyle]::Regular)
$titleFont = New-Object System.Drawing.Font('Microsoft YaHei UI', 32, [System.Drawing.FontStyle]::Bold)
$brush = New-Object System.Drawing.SolidBrush($black)
$grayBrush = New-Object System.Drawing.SolidBrush($gray)

function CenterText($text, $rect, $fontToUse, $brushToUse) {
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = [System.Drawing.StringAlignment]::Center
  $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
  $fmt.Trimming = [System.Drawing.StringTrimming]::None
  $rf = New-Object System.Drawing.RectangleF([float]$rect.X,[float]$rect.Y,[float]$rect.Width,[float]$rect.Height)
  $g.DrawString($text, $fontToUse, $brushToUse, $rf, $fmt)
  $fmt.Dispose()
}

function Box($x, $y, $ww, $hh, $text) {
  $r = New-Object System.Drawing.Rectangle($x,$y,$ww,$hh)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $radius = 14; $d = $radius * 2
  $path.AddArc($r.X, $r.Y, $d, $d, 180, 90)
  $path.AddArc($r.Right-$d, $r.Y, $d, $d, 270, 90)
  $path.AddArc($r.Right-$d, $r.Bottom-$d, $d, $d, 0, 90)
  $path.AddArc($r.X, $r.Bottom-$d, $d, $d, 90, 90)
  $path.CloseFigure()
  $g.DrawPath($pen, $path)
  $path.Dispose()
  CenterText $text $r $font $brush
}

function Arrow($x1, $y1, $x2, $y2) {
  $g.DrawLine($pen, $x1, $y1, $x2, $y2)
  $dx = $x2-$x1; $dy = $y2-$y1
  $len = [Math]::Sqrt($dx*$dx+$dy*$dy)
  if ($len -eq 0) { return }
  $ux = $dx/$len; $uy = $dy/$len
  $px = -$uy; $py = $ux
  $size = 14
  [System.Drawing.PointF]$p1 = [System.Drawing.PointF]::new([float]$x2,[float]$y2)
  [System.Drawing.PointF]$p2 = [System.Drawing.PointF]::new([float]($x2-$ux*$size+$px*($size/2)), [float]($y2-$uy*$size+$py*($size/2)))
  [System.Drawing.PointF]$p3 = [System.Drawing.PointF]::new([float]($x2-$ux*$size-$px*($size/2)), [float]($y2-$uy*$size-$py*($size/2)))
  [System.Drawing.PointF[]]$arrowPoints = @($p1,$p2,$p3)
  $g.FillPolygon($brush, $arrowPoints)
}

function Diamond($cx, $cy, $ww, $hh, $text) {
  [System.Drawing.PointF[]]$pts = @(
    [System.Drawing.PointF]::new([float]$cx, [float]($cy-$hh/2)),
    [System.Drawing.PointF]::new([float]($cx+$ww/2), [float]$cy),
    [System.Drawing.PointF]::new([float]$cx, [float]($cy+$hh/2)),
    [System.Drawing.PointF]::new([float]($cx-$ww/2), [float]$cy)
  )
  $g.DrawPolygon($pen, $pts)
  $r = New-Object System.Drawing.Rectangle([int]($cx-$ww/2+20), [int]($cy-30), [int]($ww-40), 60)
  CenterText $text $r $smallFont $brush
}

CenterText '沉浸式购物智能体 MVP 流程图' (New-Object System.Drawing.Rectangle(0,35,$w,55)) $titleFont $brush

$x = 540; $bw = 520; $bh = 74
Box $x 125 $bw $bh '用户输入购物需求'
Arrow 800 199 800 245
Box $x 245 $bw $bh 'Agent 理解需求'
Arrow 800 319 800 365
Diamond 800 435 360 140 '信息是否足够？'

# Not enough branch and return loop
Arrow 620 435 390 435
CenterText '否' (New-Object System.Drawing.Rectangle(465,405,70,40)) $smallFont $brush
Box 90 398 300 74 'Agent 继续提问'
$g.DrawLine($pen, 240, 472, 240, 560)
$g.DrawLine($pen, 240, 560, 800, 560)
Arrow 800 560 800 319

# Enough branch
Arrow 800 505 800 570
CenterText '是' (New-Object System.Drawing.Rectangle(825,525,70,40)) $smallFont $brush
Box $x 570 $bw $bh '查询改写'
Arrow 800 644 800 690
Box $x 690 $bw $bh '调用商品接口'
Arrow 800 764 800 810
Box $x 810 $bw $bh '统一商品数据格式'
Arrow 800 884 800 930
Box $x 930 $bw $bh '基础筛选和排序'

# Outcomes
Arrow 800 1004 800 1050
Box 585 1050 430 80 '生成回答和商品卡片'
Arrow 800 1130 350 1160
Arrow 800 1130 1250 1160
Box 130 1160 440 80 '保存用户偏好'
Box 1030 1160 440 80 '查看来源 / 跳转外部平台'

$g.DrawString('用户点击商品卡片', $smallFont, $grayBrush, (New-Object System.Drawing.PointF(1050, 1110)))

$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose(); $pen.Dispose(); $font.Dispose(); $smallFont.Dispose(); $titleFont.Dispose(); $brush.Dispose(); $grayBrush.Dispose()
Write-Output $out
