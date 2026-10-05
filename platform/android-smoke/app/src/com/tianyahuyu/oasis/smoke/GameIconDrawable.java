package com.tianyahuyu.oasis.smoke;

import android.graphics.Canvas;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.RadialGradient;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;

/** Native vector illustrations: no HTML, network image, bitmap or font dependency. */
final class GameIconDrawable extends Drawable {
    private final String game;
    private final int tint;
    private final Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
    private static final int IVORY = 0xFFF5E7C7;
    private static final int GOLD = 0xFFF0CC80;
    GameIconDrawable(String game, int tint) { this.game = game; this.tint = tint; }
    @Override public void draw(Canvas canvas) {
        canvas.save(); canvas.translate(getBounds().left, getBounds().top);
        canvas.scale(getBounds().width() / 100f, getBounds().height() / 100f);
        p.setStyle(Paint.Style.FILL);
        p.setShader(new RadialGradient(42, 35, 64, new int[]{tint, 0xFF172131}, null, Shader.TileMode.CLAMP));
        canvas.drawCircle(50, 50, 48, p); p.setShader(null);
        p.setStyle(Paint.Style.STROKE); p.setStrokeWidth(1); p.setColor(0x66E9C58B); canvas.drawCircle(50, 50, 47, p);
        p.setStyle(Paint.Style.FILL);
        switch (game) {
            case "match": diamond(canvas, 33, 39, 20, 0xFFBEEBFA); diamond(canvas, 65, 49, 23, 0xFFCFACF8); diamond(canvas, 41, 69, 17, GOLD); break;
            case "golf":
                oval(canvas, 16, 65, 85, 83, 0xFF397E55); line(canvas, 48, 18, 48, 69, 3, IVORY);
                polygon(canvas, new float[]{49, 19, 76, 30, 49, 40}, 0xFFF2C167);
                circle(canvas, 31, 65, 9, IVORY); circle(canvas, 48, 72, 7, 0xFF172A23); break;
            case "carrom":
                rect(canvas, 18, 18, 82, 82, 10, GOLD); rect(canvas, 25, 25, 75, 75, 5, 0xFFB07B45);
                for (float x : new float[]{25,75}) for (float y : new float[]{25,75}) circle(canvas,x,y,5,0xFF302B2B);
                circle(canvas,43,44,10,IVORY); circle(canvas,59,58,10,0xFF212637); circle(canvas,48,63,7,0xFFBD4D5B); break;
            case "darts":
                circle(canvas,49,52,33,IVORY); circle(canvas,49,52,25,0xFFBD5D6F); circle(canvas,49,52,17,0xFF243844); circle(canvas,49,52,7,GOLD);
                line(canvas,49,52,77,22,4,IVORY); polygon(canvas,new float[]{67,23,82,16,78,32},GOLD); break;
            case "ludo":
                rect(canvas,19,19,81,81,10,IVORY); rect(canvas,25,25,47,47,4,0xFFD46769); rect(canvas,53,25,75,47,4,0xFF4EAC98);
                rect(canvas,25,53,47,75,4,0xFF74A8DB); rect(canvas,53,53,75,75,4,0xFFE7B94C);
                for(float x:new float[]{36,64}) for(float y:new float[]{36,64}) circle(canvas,x,y,5,IVORY); break;
            case "jackaroo":
                canvas.save(); canvas.rotate(-13,50,50); rect(canvas,25,19,68,79,7,0xFFC6A86F); canvas.restore();
                canvas.save(); canvas.rotate(10,50,50); rect(canvas,34,20,77,79,7,IVORY);
                polygon(canvas,new float[]{55,35,41,52,44,61,52,61,49,68,61,68,58,61,66,61,70,53},0xFF2C6650); canvas.restore(); break;
            case "domino":
                canvas.save(); canvas.rotate(17,50,50); rect(canvas,29,15,73,84,8,IVORY); line(canvas,33,49,69,49,2,0xFFB6A581);
                for(float[] a:new float[][]{{41,29},{61,39},{41,61},{61,61},{51,70}})circle(canvas,a[0],a[1],4,0xFF26384A); canvas.restore(); break;
            case "pool":
                circle(canvas,49,53,31,0xFF111924); circle(canvas,49,49,16,IVORY); text(canvas,"8",49,58,25,0xFF1A2432);
                circle(canvas,35,34,7,0x554DD9C0); line(canvas,17,78,84,14,3,GOLD); break;
            case "bowling":
                pin(canvas,35,31); pin(canvas,65,31); pin(canvas,50,18); circle(canvas,58,71,22,0xFFAA8AEC);
                for(float[] a:new float[][]{{52,60},{62,62},{56,69}})circle(canvas,a[0],a[1],3,0xFF46355F); break;
            case "run":
                line(canvas,20,80,38,25,3,0x6681B4B7); line(canvas,45,84,58,24,3,0x6681B4B7); line(canvas,73,82,78,26,3,0x6681B4B7);
                polygon(canvas,new float[]{53,17,31,54,47,54,39,84,74,43,57,43,70,17},GOLD); break;
            case "towerlink":
                line(canvas,25,70,50,45,4,0xFF78F4CF); line(canvas,50,45,76,25,4,0xFFFFCA72); line(canvas,50,45,72,75,4,0xFFA98CFF);
                circle(canvas,25,70,10,0xFF78F4CF); circle(canvas,50,45,13,GOLD); circle(canvas,76,25,9,0xFFFFCA72); circle(canvas,72,75,9,0xFFA98CFF); break;
            case "thunder":
                circle(canvas,50,50,33,0xFF344E7B); polygon(canvas,new float[]{51,12,26,57,46,57,38,90,79,41,57,41,70,12},GOLD);
                circle(canvas,22,25,3,IVORY); circle(canvas,82,73,3,IVORY); break;
            case "tiger":
                circle(canvas,27,30,12,0xFFF2B754); circle(canvas,73,30,12,0xFFF2B754); circle(canvas,50,51,32,0xFFF2B754);
                circle(canvas,27,30,6,0xFF5D3A25); circle(canvas,73,30,6,0xFF5D3A25);
                oval(canvas,30,54,70,79,IVORY); line(canvas,43,24,48,38,4,0xFF654024); line(canvas,59,25,54,38,4,0xFF654024);
                line(canvas,22,48,34,51,4,0xFF654024); line(canvas,78,48,66,51,4,0xFF654024);
                circle(canvas,37,47,3,0xFF29212A); circle(canvas,63,47,3,0xFF29212A);
                polygon(canvas,new float[]{43,58,57,58,50,65},0xFF6A4039); line(canvas,50,65,50,70,2,0xFF6A4039); break;
        }
        canvas.restore();
    }
    private void pin(Canvas c,float x,float y){circle(c,x,y,6,IVORY);rect(c,x-4,y+2,x+4,y+20,4,IVORY);oval(c,x-10,y+14,x+10,y+44,IVORY);line(c,x-5,y+11,x+5,y+11,3,0xFFCB6275);}
    private void circle(Canvas c,float x,float y,float r,int color){p.setColor(color);c.drawCircle(x,y,r,p);}
    private void oval(Canvas c,float l,float t,float r,float b,int color){p.setColor(color);c.drawOval(l,t,r,b,p);}
    private void rect(Canvas c,float l,float t,float r,float b,float radius,int color){p.setColor(color);c.drawRoundRect(l,t,r,b,radius,radius,p);}
    private void line(Canvas c,float x,float y,float xx,float yy,float width,int color){p.setColor(color);p.setStrokeWidth(width);p.setStrokeCap(Paint.Cap.ROUND);c.drawLine(x,y,xx,yy,p);}
    private void polygon(Canvas c,float[] points,int color){Path path=new Path();path.moveTo(points[0],points[1]);for(int i=2;i<points.length;i+=2)path.lineTo(points[i],points[i+1]);path.close();p.setColor(color);c.drawPath(path,p);}
    private void diamond(Canvas c,float x,float y,float size,int color){polygon(c,new float[]{x,y-size,x+size,y,x,y+size,x-size,y},color);polygon(c,new float[]{x,y-size,x+size,y,x,y},0x55FFFFFF);}
    private void text(Canvas c,String s,float x,float y,float size,int color){p.setColor(color);p.setTypeface(Typeface.DEFAULT_BOLD);p.setTextSize(size);p.setTextAlign(Paint.Align.CENTER);c.drawText(s,x,y,p);}
    @Override public void setAlpha(int alpha){p.setAlpha(alpha);}
    @Override public void setColorFilter(ColorFilter filter){p.setColorFilter(filter);}
    @Override public int getOpacity(){return PixelFormat.TRANSLUCENT;}
}
