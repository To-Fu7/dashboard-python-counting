"""
Face Recognition API using facenet-pytorch
Supports face detection and matching against a local database
"""

import os
import io
import base64
import pickle
import numpy as np
from typing import Optional, List
from pathlib import Path

import torch
from PIL import Image
from facenet_pytorch import MTCNN, InceptionResnetV1
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

# Initialize FastAPI app
app = FastAPI(
    title="Face Recognition API",
    description="Face detection and recognition service using facenet-pytorch",
    version="1.0.0"
)

# Configuration
DB_PATH = "face_database.pkl"
FACE_DB_DIR = "face_database"
SIMILARITY_THRESHOLD = 0.6  # Cosine similarity threshold for matching
USE_GPU = True  # Set to False to force CPU usage

# Initialize models with CUDA support
def get_device():
    """Detect and configure CUDA device"""
    if USE_GPU and torch.cuda.is_available():
        device = torch.device('cuda:0')
        print(f"✓ CUDA is available!")
        print(f"✓ Using GPU: {torch.cuda.get_device_name(0)}")
        print(f"✓ CUDA Version: {torch.version.cuda}")
        print(f"✓ GPU Memory: {torch.cuda.get_device_properties(0).total_memory / 1024**3:.2f} GB")
        
        # Optimize CUDA settings
        torch.backends.cudnn.benchmark = True
        torch.backends.cudnn.enabled = True
        
        return device
    else:
        print("⚠ CUDA not available or disabled. Using CPU.")
        if USE_GPU:
            print("⚠ To enable GPU: Install CUDA-enabled PyTorch")
            print("⚠ Visit: https://pytorch.org/get-started/locally/")
        return torch.device('cpu')

device = get_device()

# Initialize MTCNN for face detection
mtcnn = MTCNN(
    image_size=160,
    margin=20,
    min_face_size=20,
    thresholds=[0.6, 0.7, 0.7],
    factor=0.709,
    post_process=True,
    device=device,
    keep_all=True
)

# Initialize InceptionResnetV1 for face recognition
resnet = InceptionResnetV1(pretrained='vggface2').eval().to(device)


# Request/Response models
class Base64ImageRequest(BaseModel):
    image: str = Field(..., description="Base64 encoded image")
    

class FaceRecognitionResponse(BaseModel):
    success: bool
    faces_detected: int
    matches: List[dict]
    message: Optional[str] = None


class HealthCheckResponse(BaseModel):
    status: str
    device: str
    database_loaded: bool
    registered_faces: int
    gpu_name: Optional[str] = None
    cuda_version: Optional[str] = None
    gpu_memory_total: Optional[str] = None
    gpu_memory_allocated: Optional[str] = None
    gpu_memory_cached: Optional[str] = None


# Database management
class FaceDatabase:
    def __init__(self, db_path: str):
        self.db_path = db_path
        self.embeddings = {}
        self.load_database()
    
    def load_database(self):
        """Load face embeddings from disk"""
        if os.path.exists(self.db_path):
            try:
                with open(self.db_path, 'rb') as f:
                    self.embeddings = pickle.load(f)
                print(f"Loaded {len(self.embeddings)} face(s) from database")
            except Exception as e:
                print(f"Error loading database: {e}")
                self.embeddings = {}
        else:
            print("No existing database found. Creating new database.")
            self.embeddings = {}
    
    def save_database(self):
        """Save face embeddings to disk"""
        try:
            with open(self.db_path, 'wb') as f:
                pickle.dump(self.embeddings, f)
            print(f"Saved {len(self.embeddings)} face(s) to database")
        except Exception as e:
            print(f"Error saving database: {e}")
    
    def add_face(self, name: str, embedding: np.ndarray):
        """Add a face embedding to the database"""
        if name not in self.embeddings:
            self.embeddings[name] = []
        self.embeddings[name].append(embedding)
        self.save_database()
    
    def find_match(self, embedding: np.ndarray, threshold: float = SIMILARITY_THRESHOLD):
        """Find the best match for a given embedding"""
        best_match = None
        best_similarity = -1
        
        for name, stored_embeddings in self.embeddings.items():
            for stored_emb in stored_embeddings:
                # Calculate cosine similarity
                similarity = np.dot(embedding, stored_emb) / (
                    np.linalg.norm(embedding) * np.linalg.norm(stored_emb)
                )
                
                if similarity > best_similarity:
                    best_similarity = similarity
                    best_match = name
        
        if best_similarity >= threshold:
            return best_match, float(best_similarity)
        return None, float(best_similarity)
    
    def get_all_names(self):
        """Get all registered names"""
        return list(self.embeddings.keys())
    
    def remove_face(self, name: str):
        """Remove a face from the database"""
        if name in self.embeddings:
            del self.embeddings[name]
            self.save_database()
            return True
        return False


# Initialize database
face_db = FaceDatabase(DB_PATH)


def decode_image(image_data: str) -> Image.Image:
    """Decode base64 image string to PIL Image"""
    try:
        # Remove data URL prefix if present
        if ',' in image_data:
            image_data = image_data.split(',')[1]
        
        image_bytes = base64.b64decode(image_data)
        image = Image.open(io.BytesIO(image_bytes))
        return image.convert('RGB')
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid image data: {str(e)}")


def get_face_embedding(image: Image.Image):
    """Extract face embeddings from an image"""
    # Detect faces
    faces, probs = mtcnn(image, return_prob=True)
    
    if faces is None:
        return None, None
    
    # Get embeddings with GPU optimization
    with torch.no_grad():  # Disable gradient computation for inference
        faces = faces.to(device)
        embeddings = resnet(faces).detach().cpu().numpy()
    
    # Clear GPU cache if using CUDA
    if device.type == 'cuda':
        torch.cuda.empty_cache()
    
    return embeddings, probs


# API Endpoints

@app.get("/health", response_model=HealthCheckResponse)
async def health_check():
    """Health check endpoint with GPU information"""
    gpu_info = {}
    if device.type == 'cuda':
        gpu_info = {
            "gpu_name": torch.cuda.get_device_name(0),
            "cuda_version": torch.version.cuda,
            "gpu_memory_total": f"{torch.cuda.get_device_properties(0).total_memory / 1024**3:.2f} GB",
            "gpu_memory_allocated": f"{torch.cuda.memory_allocated(0) / 1024**3:.2f} GB",
            "gpu_memory_cached": f"{torch.cuda.memory_reserved(0) / 1024**3:.2f} GB"
        }
    
    return HealthCheckResponse(
        status="healthy",
        device=str(device),
        database_loaded=True,
        registered_faces=len(face_db.get_all_names()),
        **gpu_info
    )


@app.post("/recognize", response_model=FaceRecognitionResponse)
async def recognize_face_file(file: UploadFile = File(...)):
    """
    Recognize faces from uploaded image file
    """
    try:
        # Read image
        contents = await file.read()
        image = Image.open(io.BytesIO(contents)).convert('RGB')
        
        # Get face embeddings
        embeddings, probs = get_face_embedding(image)
        
        if embeddings is None:
            return FaceRecognitionResponse(
                success=False,
                faces_detected=0,
                matches=[],
                message="No faces detected in the image"
            )
        
        # Match faces
        matches = []
        for i, (embedding, prob) in enumerate(zip(embeddings, probs)):
            name, similarity = face_db.find_match(embedding)
            matches.append({
                "face_index": i,
                "detection_confidence": float(prob),
                "matched_name": name if name else "Unknown",
                "match_confidence": similarity
            })
        
        return FaceRecognitionResponse(
            success=True,
            faces_detected=len(embeddings),
            matches=matches,
            message=f"Successfully processed {len(embeddings)} face(s)"
        )
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error processing image: {str(e)}")


@app.post("/recognize/base64", response_model=FaceRecognitionResponse)
async def recognize_face_base64(request: Base64ImageRequest):
    """
    Recognize faces from base64 encoded image
    """
    try:
        # Decode image
        image = decode_image(request.image)
        
        # Get face embeddings
        embeddings, probs = get_face_embedding(image)
        
        if embeddings is None:
            return FaceRecognitionResponse(
                success=False,
                faces_detected=0,
                matches=[],
                message="No faces detected in the image"
            )
        
        # Match faces
        matches = []
        for i, (embedding, prob) in enumerate(zip(embeddings, probs)):
            name, similarity = face_db.find_match(embedding)
            matches.append({
                "face_index": i,
                "detection_confidence": float(prob),
                "matched_name": name if name else "Unknown",
                "match_confidence": similarity
            })
        
        return FaceRecognitionResponse(
            success=True,
            faces_detected=len(embeddings),
            matches=matches,
            message=f"Successfully processed {len(embeddings)} face(s)"
        )
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error processing image: {str(e)}")


@app.post("/register")
async def register_face(name: str, file: UploadFile = File(...)):
    """
    Register a new face in the database
    """
    try:
        # Read image
        contents = await file.read()
        image = Image.open(io.BytesIO(contents)).convert('RGB')
        
        # Get face embeddings
        embeddings, probs = get_face_embedding(image)
        
        if embeddings is None:
            raise HTTPException(status_code=400, detail="No face detected in the image")
        
        if len(embeddings) > 1:
            raise HTTPException(
                status_code=400,
                detail="Multiple faces detected. Please provide an image with only one face."
            )
        
        # Add to database
        face_db.add_face(name, embeddings[0])
        
        return JSONResponse(
            status_code=201,
            content={
                "success": True,
                "message": f"Face registered for {name}",
                "detection_confidence": float(probs[0])
            }
        )
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error registering face: {str(e)}")


@app.post("/register/base64")
async def register_face_base64(name: str, request: Base64ImageRequest):
    """
    Register a new face from base64 encoded image
    """
    try:
        # Decode image
        image = decode_image(request.image)
        
        # Get face embeddings
        embeddings, probs = get_face_embedding(image)
        
        if embeddings is None:
            raise HTTPException(status_code=400, detail="No face detected in the image")
        
        if len(embeddings) > 1:
            raise HTTPException(
                status_code=400,
                detail="Multiple faces detected. Please provide an image with only one face."
            )
        
        # Add to database
        face_db.add_face(name, embeddings[0])
        
        return JSONResponse(
            status_code=201,
            content={
                "success": True,
                "message": f"Face registered for {name}",
                "detection_confidence": float(probs[0])
            }
        )
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error registering face: {str(e)}")


@app.get("/database/list")
async def list_registered_faces():
    """
    List all registered faces
    """
    names = face_db.get_all_names()
    return {
        "success": True,
        "total": len(names),
        "names": names
    }


@app.delete("/database/{name}")
async def delete_face(name: str):
    """
    Delete a registered face
    """
    success = face_db.remove_face(name)
    
    if success:
        return {
            "success": True,
            "message": f"Face for {name} deleted successfully"
        }
    else:
        raise HTTPException(status_code=404, detail=f"Face for {name} not found")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8881)